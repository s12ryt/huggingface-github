/**
 * 管理員邀請碼端點。
 *
 * 功能位置：
 * - POST   /api/admin/invites     : 行 40 — 產生，明文只在此回應出現一次
 * - GET    /api/admin/invites     : 行 70 — 列出，永不含雜湊
 * - DELETE /api/admin/invites/:id : 行 76 — 軟撤銷
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createInviteCode, InviteParamError, listInviteCodes, revokeInviteCode } from '../../invite/code.js';
import type { CreateInviteParams } from '../../invite/params.js';
import { sendError } from '../errors.js';
import { asRecord, isNonEmptyString } from '../payload.js';
import { requireAdmin } from '../principal.js';

export interface AdminInviteDeps {
  prisma: PrismaClient;
}

type OptionalParams = Omit<CreateInviteParams, 'createdById'>;

function readOptionalParams(body: Record<string, unknown>): OptionalParams | null {
  const params: OptionalParams = {};
  if (body.role !== undefined) {
    if (typeof body.role !== 'string') return null;
    params.role = body.role as NonNullable<OptionalParams['role']>;
  }
  if (body.maxUses !== undefined) {
    if (typeof body.maxUses !== 'number') return null;
    params.maxUses = body.maxUses;
  }
  if (body.note !== undefined) {
    if (!isNonEmptyString(body.note)) return null;
    params.note = body.note;
  }
  if (body.usernamePattern !== undefined) {
    if (!isNonEmptyString(body.usernamePattern)) return null;
    params.usernamePattern = body.usernamePattern;
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (!isNonEmptyString(body.expiresAt)) return null;
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) return null;
    params.expiresAt = parsed;
  }
  return params;
}

export function registerAdminInviteRoutes(app: FastifyInstance, deps: AdminInviteDeps): void {
  const { prisma } = deps;

  app.post('/api/admin/invites', async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return reply;

    const params = readOptionalParams(asRecord(request.body));
    if (!params) return sendError(reply, 400, 'invalid_invite_params');

    try {
      const issued = await createInviteCode(prisma, { createdById: admin.id, ...params });
      return reply.code(201).send(issued);
    } catch (error) {
      if (error instanceof InviteParamError) return sendError(reply, 400, 'invalid_invite_params');
      throw error;
    }
  });

  app.get('/api/admin/invites', async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return reply;
    return reply.send({ invites: await listInviteCodes(prisma) });
  });

  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return reply;

    const revoked = await revokeInviteCode(prisma, request.params.id);
    if (!revoked) return sendError(reply, 404, 'not_found');
    return reply.code(204).send();
  });
}
