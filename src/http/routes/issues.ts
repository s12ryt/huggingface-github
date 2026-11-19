/**
 * Issues HTTP 端點。
 *
 * - GET    /api/repos/:owner/:repo/issues[?state=]      列出
 * - POST   /api/repos/:owner/:repo/issues               建立（需寫權）
 * - GET    /api/repos/:owner/:repo/issues/:number       取得單一（含留言）
 * - PATCH  /api/repos/:owner/:repo/issues/:number       改狀態（需寫權）
 * - POST   /api/repos/:owner/:repo/issues/:number/comments  留言（需寫權）
 *
 * 寫入一律經服務層，確保 SQLite 與 儲存桶 JSON 同步。
 */
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { sendError } from '../errors.js';
import { asRecord } from '../payload.js';
import { requireRepoRead, requireRepoWrite } from '../repo-scope.js';
import {
  addIssueComment,
  createIssue,
  ISSUE_STATES,
  IssueError,
  listIssues,
  setIssueState,
  type IssueState,
} from '../../issues/service.js';
import type { Store } from '../../storage/store.js';

export interface IssueRouteDeps {
  prisma: PrismaClient;
  store: Store;
}

interface NumberParam {
  number: string;
}

function isState(value: unknown): value is IssueState {
  return typeof value === 'string' && (ISSUE_STATES as readonly string[]).includes(value);
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function registerIssueRoutes(app: FastifyInstance, deps: IssueRouteDeps): void {
  const base = '/api/repos/:owner/:repo/issues';

  app.get(base, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;

    const raw = (request.query as { state?: string }).state;
    if (raw !== undefined && !isState(raw)) return sendError(reply, 400, 'invalid_state');
    const issues = await listIssues(deps.prisma, scope.repoId, raw as IssueState | undefined);
    return reply.send({ issues });
  });

  app.post(base, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const body = asRecord(request.body);
    try {
      const issue = await createIssue(deps.prisma, deps.store, {
        authorId: scope.user.id,
        body: typeof body.body === 'string' ? body.body : '',
        repoId: scope.repoId,
        repoPath: scope.repoPath,
        title: typeof body.title === 'string' ? body.title : '',
      });
      return reply.code(201).send({ issue });
    } catch (error) {
      if (error instanceof IssueError) return sendError(reply, 400, 'invalid_issue');
      throw error;
    }
  });

  app.get(`${base}/:number`, async (request, reply) => {
    const scope = await requireRepoRead(deps.prisma, request, reply);
    if (!scope) return reply;

    const number = parseNumber((request.params as NumberParam).number);
    if (number === null) return sendError(reply, 404, 'not_found');

    const issue = await deps.prisma.issue.findUnique({
      select: {
        author: { select: { username: true } },
        body: true,
        closedAt: true,
        comments: {
          orderBy: { createdAt: 'asc' },
          select: { author: { select: { username: true } }, body: true, createdAt: true },
        },
        id: true,
        number: true,
        state: true,
        title: true,
      },
      where: { repoId_number: { number, repoId: scope.repoId } },
    });
    if (!issue) return sendError(reply, 404, 'not_found');

    return reply.send({
      issue: {
        ...issue,
        author: issue.author.username,
        comments: issue.comments.map((c) => ({ ...c, author: c.author.username })),
      },
    });
  });

  app.patch(`${base}/:number`, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const number = parseNumber((request.params as NumberParam).number);
    if (number === null) return sendError(reply, 404, 'not_found');

    const state = asRecord(request.body).state;
    if (!isState(state)) return sendError(reply, 400, 'invalid_state');

    const found = await deps.prisma.issue.findUnique({
      select: { id: true },
      where: { repoId_number: { number, repoId: scope.repoId } },
    });
    if (!found) return sendError(reply, 404, 'not_found');

    const issue = await setIssueState(deps.prisma, deps.store, {
      issueId: found.id,
      repoPath: scope.repoPath,
      state,
    });
    return reply.send({ issue });
  });

  app.post(`${base}/:number/comments`, async (request, reply) => {
    const scope = await requireRepoWrite(deps.prisma, request, reply);
    if (!scope) return reply;

    const number = parseNumber((request.params as NumberParam).number);
    if (number === null) return sendError(reply, 404, 'not_found');

    const found = await deps.prisma.issue.findUnique({
      select: { id: true },
      where: { repoId_number: { number, repoId: scope.repoId } },
    });
    if (!found) return sendError(reply, 404, 'not_found');

    const body = asRecord(request.body).body;
    try {
      await addIssueComment(deps.prisma, deps.store, {
        authorId: scope.user.id,
        body: typeof body === 'string' ? body : '',
        issueId: found.id,
        repoPath: scope.repoPath,
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof IssueError) return sendError(reply, 400, 'invalid_issue');
      throw error;
    }
  });
}
