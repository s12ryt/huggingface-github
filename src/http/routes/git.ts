/**
 * Git Smart HTTP 傳輸路由。
 *
 * 功能位置：
 * - registerGitRoutes()  : 行 118 — 掛載三個端點
 * - GET  info/refs       : 行 125 — 服務廣告（upload 需讀、receive 需寫）
 * - POST git-upload-pack : 行 152 — 依 want/have 產出 packfile
 * - POST git-receive-pack: 行 178 — 入庫 packfile 並更新 ref
 *
 * 存在性隱藏：未認證者一律回 401（附 WWW-Authenticate 讓 git 提示輸入憑證），
 * 已認證但無讀取權者回 404，因此外人無法區分「repo 不存在」與「無權存取」。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { createObjectReader } from '../../git/reader.js';
import { buildPackFile, collectReachable } from '../../git/writer.js';
import { applyCommands, storePack } from '../../git/receive.js';
import {
  RECEIVE_CAPABILITIES,
  UPLOAD_CAPABILITIES,
  advertiseRefs,
  parsePushCommands,
  parseUploadRequest,
  reportStatus,
  serviceAdvertisement,
  uploadResponse,
} from '../../git/protocol.js';
import type { Store } from '../../storage/store.js';
import { canRead, canWrite, resolveAccess } from '../../repos/access.js';
import { authenticateBasic } from '../basic-auth.js';
import { sendError } from '../errors.js';

export interface GitRouteDeps {
  prisma: PrismaClient;
  store: Store;
}

const UPLOAD_SERVICE = 'git-upload-pack';
const RECEIVE_SERVICE = 'git-receive-pack';
const SERVICES = new Set([UPLOAD_SERVICE, RECEIVE_SERVICE]);

interface RepoParams {
  owner: string;
  repo: string;
}

interface Target {
  defaultBranch: string;
  repoId: string;
  repoPath: string;
}

function gitHeaders(reply: FastifyReply, contentType: string): void {
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-cache, max-age=0, must-revalidate');
  reply.header('pragma', 'no-cache');
}

async function challenge(reply: FastifyReply): Promise<FastifyReply> {
  reply.header('www-authenticate', 'Basic realm="onedrive-github"');
  return sendError(reply, 401, 'unauthenticated');
}

/**
 * 解析 repo 並完成授權。回傳 null 時 reply 已送出，呼叫端直接返回。
 */
async function authorize(
  deps: GitRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  needWrite: boolean,
): Promise<Target | null> {
  const { owner, repo } = request.params as RepoParams;
  // 認證（argon2，CPU 重）與 repo 查詢互不依賴，並行發出以縮短每次請求的等待。
  const [actor, found] = await Promise.all([
    authenticateBasic(deps.prisma, request.headers.authorization),
    deps.prisma.repo.findFirst({
      where: { name: repo, owner: { username: owner.toLowerCase() } },
      select: { defaultBranch: true, id: true, storagePath: true },
    }),
  ]);

  if (!found) {
    if (!actor) {
      await challenge(reply);
      return null;
    }
    await sendError(reply, 404, 'not_found');
    return null;
  }

  const access = await resolveAccess(
    deps.prisma,
    found.id,
    actor ? { id: actor.id, role: actor.role } : null,
  );

  if (!canRead(access)) {
    if (!actor) {
      await challenge(reply);
      return null;
    }
    await sendError(reply, 404, 'not_found');
    return null;
  }

  if (needWrite && !canWrite(access)) {
    if (!actor) {
      await challenge(reply);
      return null;
    }
    await sendError(reply, 403, 'forbidden');
    return null;
  }

  return { defaultBranch: found.defaultBranch, repoId: found.id, repoPath: found.storagePath };
}

export function registerGitRoutes(app: FastifyInstance, deps: GitRouteDeps): void {
  app.addContentTypeParser(
    ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.get('/:owner/:repo/info/refs', async (request, reply) => {
    const service = (request.query as { service?: string }).service;
    if (!service) return sendError(reply, 404, 'not_found');
    if (!SERVICES.has(service)) return sendError(reply, 403, 'forbidden');

    const target = await authorize(deps, request, reply, service === RECEIVE_SERVICE);
    if (!target) return reply;

    const refs = await deps.prisma.repoRef.findMany({
      where: { repoId: target.repoId },
      select: { name: true, targetOid: true },
    });

    const capabilities = service === UPLOAD_SERVICE ? UPLOAD_CAPABILITIES : RECEIVE_CAPABILITIES;
    gitHeaders(reply, `application/x-${service}-advertisement`);
    return reply.send(
      Buffer.concat([
        serviceAdvertisement(service),
        advertiseRefs(
          refs.map((ref) => ({ name: ref.name, oid: ref.targetOid })),
          target.defaultBranch,
          capabilities,
        ),
      ]),
    );
  });

  app.post('/:owner/:repo/git-upload-pack', async (request, reply) => {
    const target = await authorize(deps, request, reply, false);
    if (!target) return reply;

    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const parsed = parseUploadRequest(body);

    const reader = createObjectReader(deps.prisma, deps.store, {
      repoId: target.repoId,
      repoPath: target.repoPath,
    });
    const oids = await collectReachable(reader, parsed.wants, parsed.haves);
    const pack = await buildPackFile(reader, oids);

    gitHeaders(reply, `application/x-${UPLOAD_SERVICE}-result`);
    return reply.send(uploadResponse(pack, [], parsed.capabilities.includes('side-band-64k')));
  });

  app.post('/:owner/:repo/git-receive-pack', async (request, reply) => {
    const target = await authorize(deps, request, reply, true);
    if (!target) return reply;

    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const parsed = parsePushCommands(body);

    gitHeaders(reply, `application/x-${RECEIVE_SERVICE}-result`);

    try {
      if (parsed.packData.length > 0) {
        await storePack(deps.prisma, deps.store, target, parsed.packData);
      }
    } catch {
      return reply.send(reportStatus([], 'index-pack failed'));
    }

    const results = await applyCommands(deps.prisma, target.repoId, parsed.commands);
    return reply.send(reportStatus(results));
  });
}
