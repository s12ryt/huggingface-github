/**
 * Repo 子資源的共用守門。
 *
 * - resolveRepoAccess：解析 repo 與存取權，無讀權一律 404（匿名則由呼叫端給 401）
 * - requireRepoRead / requireRepoWrite：讀寫兩種門檻
 *
 * 安全不變量：匿名回 401、已認證但無權回 404，使外人無法區分「不存在」與「無權」。
 */
import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from './errors.js';
import { readPrincipal } from './principal.js';
import { canRead, canWrite, resolveAccess } from '../repos/access.js';
import { findRepoByPath, repoStoragePath } from '../repos/service.js';
import type { AuthUser } from '../auth/principal.js';

export interface RepoScope {
  repoId: string;
  repoPath: string;
  user: AuthUser;
}

interface PathParams {
  owner: string;
  repo: string;
}

async function locate(prisma: PrismaClient, request: FastifyRequest) {
  const { owner, repo } = request.params as PathParams;
  // repo 查詢與身分解析互不依賴，並行發出以縮短每個 repo 子資源請求的守門時間。
  const [found, user] = await Promise.all([
    findRepoByPath(prisma, owner, repo),
    readPrincipal(prisma, request),
  ]);
  if (!found) return { access: null, repo: null, user };
  const actor = user ? { id: user.id, role: user.role } : null;
  return { access: await resolveAccess(prisma, found.id, actor), repo: found, user };
}

/** 讀取門檻。回傳 null 表示 reply 已送出。 */
export async function requireRepoRead(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ repoId: string; repoPath: string; user: AuthUser | null } | null> {
  const { access, repo, user } = await locate(prisma, request);
  if (!repo || !access || !canRead(access)) {
    await sendError(reply, 404, 'not_found');
    return null;
  }
  return { repoId: repo.id, repoPath: repoStoragePath(repo.owner, repo.name), user };
}

/** 寫入門檻：匿名 401、可讀但不可寫 403、不可讀 404。 */
export async function requireRepoWrite(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RepoScope | null> {
  const { access, repo, user } = await locate(prisma, request);
  if (!user) {
    await sendError(reply, 401, 'unauthenticated');
    return null;
  }
  if (!repo || !access || !canRead(access)) {
    await sendError(reply, 404, 'not_found');
    return null;
  }
  if (!canWrite(access)) {
    await sendError(reply, 403, 'forbidden');
    return null;
  }
  return { repoId: repo.id, repoPath: repoStoragePath(repo.owner, repo.name), user };
}
