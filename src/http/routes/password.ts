/**
 * 自助改密端點。
 *
 * 功能位置：
 * - POST /api/auth/password : 行 25 — 驗證當前密碼後換發，並撤銷所有工作階段
 *
 * 安全不變量：當前密碼錯誤與帳號狀態異常都回同一個 invalid_credentials，
 * 不讓呼叫端從錯誤碼推斷帳號細節。
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { changePassword } from '../../auth/bootstrap.js';
import { PasswordPolicyError, verifyPassword } from '../../auth/password.js';
import { sendError } from '../errors.js';
import { asRecord, isNonEmptyString } from '../payload.js';
import { requirePrincipal } from '../principal.js';

export interface PasswordDeps {
  prisma: PrismaClient;
  rateLimitMax: number;
}

export function registerPasswordRoutes(app: FastifyInstance, deps: PasswordDeps): void {
  const { prisma } = deps;

  app.post(
    '/api/auth/password',
    { config: { rateLimit: { max: deps.rateLimitMax, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await requirePrincipal(prisma, request, reply);
      if (!user) return reply;

      const body = asRecord(request.body);
      if (
        !isNonEmptyString(body.currentPassword) ||
        !isNonEmptyString(body.newPassword) ||
        !isNonEmptyString(body.newPasswordConfirm)
      ) {
        return sendError(reply, 400, 'invalid_payload');
      }
      if (body.newPassword !== body.newPasswordConfirm) {
        return sendError(reply, 400, 'password_mismatch');
      }

      const found = await prisma.user.findUnique({
        where: { id: user.id },
        select: { passwordHash: true },
      });
      const matched = found
        ? await verifyPassword(found.passwordHash, body.currentPassword)
        : false;
      if (!matched) return sendError(reply, 400, 'invalid_credentials');

      try {
        await changePassword(prisma, user.username, body.newPassword);
      } catch (error) {
        if (error instanceof PasswordPolicyError) return sendError(reply, 400, 'weak_password');
        throw error;
      }
      return reply.code(204).send();
    },
  );
}
