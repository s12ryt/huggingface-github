/**
 * Repo CRUD HTTP 端點。
 *
 * - POST   /api/repos                                        建立
 * - GET    /api/repos                                        列出自己可存取的
 * - GET    /api/repos/:owner/:repo                           取得單一
 * - DELETE /api/repos/:owner/:repo                           刪除（僅擁有者或站台管理員）
 * - PUT/DELETE/GET /api/repos/:owner/:repo/collaborators[/:username]  協作者維護
 *
 * 安全不變量：無讀取權者一律回 404，使外人無法區分「不存在」與「無權」。
 */
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from '../errors.js';
import { asRecord } from '../payload.js';
import { readPrincipal, requirePrincipal, ADMIN_ROLE } from '../principal.js';
import { canRead, isCollaboratorRole, resolveAccess } from '../../repos/access.js';
import { RepoNameError } from '../../repos/name.js';
import {
  createRepo,
  findRepoByPath,
  isVisibility,
  listAccessibleRepos,
  listCollaborators,
  removeCollaborator,
  RepoExistsError,
  setCollaborator,
  type RepoSummary,
} from '../../repos/service.js';

export interface RepoRouteDeps {
  prisma: PrismaClient;
  publicUrl: string;
}

interface PathParams {
  owner: string;
  repo: string;
  username?: string;
}

function withCloneUrl(repo: RepoSummary, publicUrl: string) {
  return { ...repo, cloneUrl: `${publicUrl}/${repo.owner}/${repo.name}.git` };
}

/**
 * 解析 repo 並確認讀取權。回傳 null 時 reply 已送出。
 * 讀不到一律 404，不論是不存在或無權。
 */
async function readable(deps: RepoRouteDeps, request: FastifyRequest, reply: FastifyReply) {
  const { owner, repo } = request.params as PathParams;
  // repo 查詢與身分解析互不依賴，並行發出。
  const [found, user] = await Promise.all([
    findRepoByPath(deps.prisma, owner, repo),
    readPrincipal(deps.prisma, request),
  ]);
  const actor = user ? { id: user.id, role: user.role } : null;
  if (!found) {
    await sendError(reply, 404, 'not_found');
    return null;
  }
  const access = await resolveAccess(deps.prisma, found.id, actor);
  if (!canRead(access)) {
    await sendError(reply, 404, 'not_found');
    return null;
  }
  return { access, repo: found };
}

export function registerRepoRoutes(app: FastifyInstance, deps: RepoRouteDeps): void {
  app.post('/api/repos', async (request, reply) => {
    const user = await requirePrincipal(deps.prisma, request, reply);
    if (!user) return reply;

    const body = asRecord(request.body);
    if (body.visibility !== undefined && !isVisibility(body.visibility)) {
      return sendError(reply, 400, 'invalid_visibility');
    }
    try {
      const repo = await createRepo(deps.prisma, {
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        name: body.name,
        ownerId: user.id,
        ownerUsername: user.username,
        ...(isVisibility(body.visibility) ? { visibility: body.visibility } : {}),
      });
      return reply.code(201).send({ repo: withCloneUrl(repo, deps.publicUrl) });
    } catch (error) {
      if (error instanceof RepoNameError) return sendError(reply, 400, 'invalid_repo_name');
      if (error instanceof RepoExistsError) return sendError(reply, 409, 'repo_exists');
      throw error;
    }
  });

  app.get('/api/repos', async (request, reply) => {
    const user = await requirePrincipal(deps.prisma, request, reply);
    if (!user) return reply;
    const repos = await listAccessibleRepos(deps.prisma, user.id);
    return reply.send({ repos: repos.map((repo) => withCloneUrl(repo, deps.publicUrl)) });
  });

  app.get('/api/repos/:owner/:repo', async (request, reply) => {
    const ctx = await readable(deps, request, reply);
    if (!ctx) return reply;
    return reply.send({ repo: withCloneUrl(ctx.repo, deps.publicUrl) });
  });

  app.delete('/api/repos/:owner/:repo', async (request, reply) => {
    const ctx = await readable(deps, request, reply);
    if (!ctx) return reply;
    if (!ctx.access.isOwner && !ctx.access.isSiteAdmin) return sendError(reply, 403, 'forbidden');
    await deps.prisma.repo.delete({ where: { id: ctx.repo.id } });
    return reply.code(204).send();
  });

  app.get('/api/repos/:owner/:repo/collaborators', async (request, reply) => {
    const ctx = await readable(deps, request, reply);
    if (!ctx) return reply;
    return reply.send({ collaborators: await listCollaborators(deps.prisma, ctx.repo.id) });
  });

  app.put('/api/repos/:owner/:repo/collaborators/:username', async (request, reply) => {
    const ctx = await readable(deps, request, reply);
    if (!ctx) return reply;
    if (!ctx.access.isOwner && !ctx.access.isSiteAdmin) return sendError(reply, 403, 'forbidden');

    const body = asRecord(request.body);
    const role = body.role === undefined ? 'read' : body.role;
    if (!isCollaboratorRole(role)) return sendError(reply, 400, 'invalid_role');

    const { username } = request.params as PathParams;
    const target = await deps.prisma.user.findUnique({
      select: { id: true },
      where: { username: (username ?? '').toLowerCase() },
    });
    if (!target) return sendError(reply, 404, 'not_found');

    const ownerRow = await deps.prisma.repo.findUnique({
      select: { ownerId: true },
      where: { id: ctx.repo.id },
    });
    if (ownerRow?.ownerId === target.id) {
      return sendError(reply, 400, 'owner_is_not_collaborator');
    }

    await setCollaborator(deps.prisma, ctx.repo.id, target.id, role);
    return reply.code(204).send();
  });

  app.delete('/api/repos/:owner/:repo/collaborators/:username', async (request, reply) => {
    const ctx = await readable(deps, request, reply);
    if (!ctx) return reply;
    if (!ctx.access.isOwner && !ctx.access.isSiteAdmin) return sendError(reply, 403, 'forbidden');

    const { username } = request.params as PathParams;
    const target = await deps.prisma.user.findUnique({
      select: { id: true },
      where: { username: (username ?? '').toLowerCase() },
    });
    if (!target) return sendError(reply, 404, 'not_found');
    const removed = await removeCollaborator(deps.prisma, ctx.repo.id, target.id);
    if (!removed) return sendError(reply, 404, 'not_found');
    return reply.code(204).send();
  });
}

export { ADMIN_ROLE };
