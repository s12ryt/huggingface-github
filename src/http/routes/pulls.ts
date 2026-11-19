/**
 * Pull request HTTP 端點。
 *
 * - GET    /api/repos/:owner/:repo/pulls[?state=]           列出
 * - POST   /api/repos/:owner/:repo/pulls                    開啟（需寫權）
 * - GET    /api/repos/:owner/:repo/pulls/:number            取得單一（含審查）
 * - PATCH  /api/repos/:owner/:repo/pulls/:number            開啟/關閉（需寫權）
 * - POST   /api/repos/:owner/:repo/pulls/:number/reviews    審查（讀權即可）
 * - POST   /api/repos/:owner/:repo/pulls/:number/merge      合併（需寫權）
 * - GET    /api/repos/:owner/:repo/pulls/:number/diff       樹比對（讀權即可）
 */
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { sendError } from '../errors.js';
import { asRecord } from '../payload.js';
import { requireRepoRead, requireRepoWrite } from '../repo-scope.js';
import { createObjectReader } from '../../git/reader.js';
import {
  addReview,
  createPullRequest,
  diffTrees,
  listPullRequests,
  mergePullRequest,
  PULL_STATES,
  PullError,
  setPullState,
  type PullState,
  type ReviewCommentInput,
  type ReviewSide,
  type ReviewState,
} from '../../pulls/service.js';
import type { Store } from '../../storage/store.js';

export interface PullRouteDeps {
  prisma: PrismaClient;
  store: Store;
}

interface NumberParam {
  number: string;
}

const OID_PATTERN = /^[0-9a-f]{40}$/;

function isState(value: unknown): value is PullState {
  return typeof value === 'string' && (PULL_STATES as readonly string[]).includes(value);
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把請求裡的行級留言轉成服務層輸入，任一欄位不合格回 null 讓路由回 400。 */
function readComments(value: unknown): ReviewCommentInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: ReviewCommentInput[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    if (typeof item.body !== 'string' || typeof item.filePath !== 'string') return null;
    if (typeof item.line !== 'number') return null;
    const side = item.side === undefined ? undefined : (item.side as ReviewSide);
    out.push({
      body: item.body,
      filePath: item.filePath,
      line: item.line,
      ...(side ? { side } : {}),
    });
  }
  return out;
}

export function registerPullRoutes(app: FastifyInstance, deps: PullRouteDeps): void {
  const base = '/api/repos/:owner/:repo/pulls';

  /** 解析 :number 為實際的 PR id，順便擔任 404 守門。 */
  async function findId(repoId: string, raw: string): Promise<string | null> {
    const number = parseNumber(raw);
    if (number === null) return null;
    const row = await deps.prisma.pullRequest.findUnique({
      select: { id: true },
      where: { repoId_number: { number, repoId } },
    });
    return row?.id ?? null;
  }

  app.get(base, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;

    const raw = (request.query as { state?: string }).state;
    if (raw !== undefined && !isState(raw)) return sendError(reply, 400, 'invalid_state');
    const pulls = await listPullRequests(deps.prisma, scope.repoId, raw as PullState | undefined);
    return reply.send({ pulls });
  });

  app.post(base, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const body = asRecord(request.body);
    try {
      const pull = await createPullRequest(deps.prisma, deps.store, {
        authorId: scope.user.id,
        baseOid: text(body.baseOid),
        baseRef: text(body.baseRef),
        body: text(body.body),
        headOid: text(body.headOid),
        headRef: text(body.headRef),
        repoId: scope.repoId,
        repoPath: scope.repoPath,
        title: text(body.title),
      });
      return reply.code(201).send({ pull });
    } catch (error) {
      if (error instanceof PullError) return sendError(reply, 400, 'invalid_pull');
      throw error;
    }
  });

  app.get(`${base}/:number`, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;

    const number = parseNumber((request.params as NumberParam).number);
    if (number === null) return sendError(reply, 404, 'not_found');

    const pull = await deps.prisma.pullRequest.findUnique({
      select: {
        author: { select: { username: true } },
        baseOid: true,
        baseRef: true,
        body: true,
        headOid: true,
        headRef: true,
        id: true,
        mergedAt: true,
        mergedBy: { select: { username: true } },
        number: true,
        reviews: {
          orderBy: { createdAt: 'asc' },
          select: {
            body: true,
            comments: { select: { body: true, filePath: true, line: true, side: true } },
            createdAt: true,
            reviewer: { select: { username: true } },
            state: true,
          },
        },
        state: true,
        title: true,
      },
      where: { repoId_number: { number, repoId: scope.repoId } },
    });
    if (!pull) return sendError(reply, 404, 'not_found');

    return reply.send({
      pull: {
        ...pull,
        author: pull.author.username,
        mergedBy: pull.mergedBy?.username ?? null,
        reviews: pull.reviews.map((r) => ({ ...r, reviewer: r.reviewer.username })),
      },
    });
  });

  app.patch(`${base}/:number`, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const id = await findId(scope.repoId, (request.params as NumberParam).number);
    if (!id) return sendError(reply, 404, 'not_found');

    const state = asRecord(request.body).state;
    if (state !== 'open' && state !== 'closed') return sendError(reply, 400, 'invalid_state');

    try {
      const pull = await setPullState(deps.prisma, deps.store, {
        pullRequestId: id,
        repoPath: scope.repoPath,
        state,
      });
      return reply.send({ pull });
    } catch (error) {
      if (error instanceof PullError) return sendError(reply, 400, 'invalid_pull');
      throw error;
    }
  });

  // 審查只需讀權：協作者看得到程式碼就該能表達意見。
  app.post(`${base}/:number/reviews`, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;
    if (!scope.user) return sendError(reply, 401, 'unauthenticated');

    const id = await findId(scope.repoId, (request.params as NumberParam).number);
    if (!id) return sendError(reply, 404, 'not_found');

    const body = asRecord(request.body);
    const comments = readComments(body.comments);
    if (!comments) return sendError(reply, 400, 'invalid_review');

    try {
      await addReview(deps.prisma, deps.store, {
        body: text(body.body),
        comments,
        pullRequestId: id,
        repoPath: scope.repoPath,
        reviewerId: scope.user.id,
        state: body.state as ReviewState,
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof PullError) return sendError(reply, 400, 'invalid_review');
      throw error;
    }
  });

  app.post(`${base}/:number/merge`, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const id = await findId(scope.repoId, (request.params as NumberParam).number);
    if (!id) return sendError(reply, 404, 'not_found');

    try {
      const pull = await mergePullRequest(deps.prisma, deps.store, {
        mergedById: scope.user.id,
        pullRequestId: id,
        repoPath: scope.repoPath,
      });
      return reply.send({ pull });
    } catch (error) {
      if (error instanceof PullError) return sendError(reply, 400, 'invalid_pull');
      throw error;
    }
  });

  app.get(`${base}/:number/diff`, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;

    const { base: baseTree, head: headTree } = request.query as { base?: string; head?: string };
    if (!baseTree || !headTree) return sendError(reply, 400, 'invalid_tree');
    if (!OID_PATTERN.test(baseTree) || !OID_PATTERN.test(headTree)) {
      return sendError(reply, 400, 'invalid_tree');
    }

    const reader = createObjectReader(deps.prisma, deps.store, {
      repoId: scope.repoId,
      repoPath: scope.repoPath,
    });
    const files = await diffTrees(reader, baseTree, headTree);
    return reply.send({ files });
  });
}
