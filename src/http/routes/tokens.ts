/**
 * 個人存取憑證（PAT）自助管理端點。
 *
 * 功能位置：
 * - POST   /api/tokens     : 行 33 — 簽發，明文只在此回應出現一次
 * - GET    /api/tokens     : 行 68 — 列出，永不含雜湊或明文
 * - DELETE /api/tokens/:id : 行 76 — 軟撤銷，僅限本人
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  DuplicateTokenNameError,
  InvalidScopeError,
  issueAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from '../../auth/pat.js';
import { sendError } from '../errors.js';
import { asRecord, isNonEmptyString } from '../payload.js';
import { requirePrincipal } from '../principal.js';

export interface TokenDeps {
  prisma: PrismaClient;
}

function parseExpiry(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function registerTokenRoutes(app: FastifyInstance, deps: TokenDeps): void {
  const { prisma } = deps;

  app.post('/api/tokens', async (request, reply) => {
    const user = await requirePrincipal(prisma, request, reply);
    if (!user) return reply;

    const body = asRecord(request.body);
    if (!isNonEmptyString(body.name)) return sendError(reply, 400, 'invalid_payload');

    const scopes = body.scopes === undefined ? undefined : body.scopes;
    if (scopes !== undefined && !Array.isArray(scopes)) return sendError(reply, 400, 'invalid_scope');

    const expiresAt = parseExpiry(body.expiresAt);
    if (expiresAt === undefined) return sendError(reply, 400, 'invalid_payload');

    try {
      const issued = await issueAccessToken(prisma, {
        userId: user.id,
        name: body.name.trim(),
        ...(scopes === undefined ? {} : { scopes: scopes as readonly string[] }),
        ...(expiresAt === null ? {} : { expiresAt }),
      });
      return reply.code(201).send(issued);
    } catch (error) {
      if (error instanceof InvalidScopeError) return sendError(reply, 400, 'invalid_scope');
      if (error instanceof DuplicateTokenNameError) return sendError(reply, 409, 'duplicate_token_name');
      throw error;
    }
  });

  app.get('/api/tokens', async (request, reply) => {
    const user = await requirePrincipal(prisma, request, reply);
    if (!user) return reply;
    return reply.send({ tokens: await listAccessTokens(prisma, user.id) });
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (request, reply) => {
    const user = await requirePrincipal(prisma, request, reply);
    if (!user) return reply;

    const revoked = await revokeAccessToken(prisma, { userId: user.id, tokenId: request.params.id });
    if (!revoked) return sendError(reply, 404, 'not_found');
    return reply.code(204).send();
  });
}
