/**
 * 工作階段路由：登入、登出、目前身分。
 *
 * 功能位置：
 * - SessionDeps          : 行 22 — 路由依賴
 * - registerSessionRoutes: 行 31 — 掛載三個端點
 * - POST /api/auth/login : 行 35
 * - POST /api/auth/logout: 行 80
 * - GET  /api/me         : 行 95
 *
 * 安全不變量：
 * - 帳號不存在、密碼錯誤、帳號停用三者一律回 401 invalid_credentials，
 *   且都會實際執行一次雜湊驗證，避免以回應時間區分帳號是否存在。
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { createSession, revokeSession } from '../../auth/session.js';
import { SESSION_COOKIE_NAME, clearedCookieOptions, sessionCookieOptions } from '../cookies.js';
import { sendError } from '../errors.js';
import { asRecord, isNonEmptyString } from '../payload.js';
import { requirePrincipal } from '../principal.js';

export interface SessionDeps {
  prisma: PrismaClient;
  secureCookie: boolean;
  rateLimitMax: number;
}

const RATE_WINDOW = '1 minute';

/**
 * 帳號不存在時用來比對的佔位雜湊：首次登入時以相同參數現算一次並快取，
 * 使「查無此人」與「密碼錯誤」的耗時落在同一量級。
 */
let placeholder: string | null = null;
async function placeholderHash(): Promise<string> {
  placeholder ??= await hashPassword('timing-equalization-placeholder');
  return placeholder;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionDeps): void {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: deps.rateLimitMax, timeWindow: RATE_WINDOW } } },
    async (request, reply) => {
      const body = asRecord(request.body);
      if (!isNonEmptyString(body.username) || !isNonEmptyString(body.password)) {
        return sendError(reply, 400, 'invalid_payload');
      }

      const username = body.username.trim().toLowerCase();
      const found = await deps.prisma.user.findUnique({
        where: { username },
        select: {
          id: true,
          username: true,
          role: true,
          isActive: true,
          mustChangePassword: true,
          passwordHash: true,
        },
      });

      const matched = await verifyPassword(
        found?.passwordHash ?? (await placeholderHash()),
        body.password,
      );
      if (!found || !matched || !found.isActive) {
        return sendError(reply, 401, 'invalid_credentials');
      }

      await deps.prisma.user.update({
        where: { id: found.id },
        data: { lastLoginAt: new Date() },
      });

      const userAgent = request.headers['user-agent'];
      const session = await createSession(deps.prisma, {
        userId: found.id,
        ipAddress: request.ip,
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      });
      reply.setCookie(
        SESSION_COOKIE_NAME,
        session.token,
        sessionCookieOptions(session.expiresAt, deps.secureCookie),
      );
      return reply.status(200).send({
        user: {
          id: found.id,
          username: found.username,
          role: found.role,
          mustChangePassword: found.mustChangePassword,
        },
      });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    // 直接以 cookie 中的原始 token 撤銷（撤銷函式自行雜湊比對）。
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (typeof token === 'string' && token.length > 0) {
      await revokeSession(deps.prisma, token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, clearedCookieOptions(deps.secureCookie));
    return reply.status(204).send();
  });

  app.get('/api/me', async (request, reply) => {
    const user = await requirePrincipal(deps.prisma, request, reply);
    if (!user) return reply;
    return reply.status(200).send({ user });
  });
}
