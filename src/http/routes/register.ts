/**
 * 註冊路由（開放模式與邀請碼模式共用）。
 *
 * 功能位置：
 * - RegisterDeps          : 行 25 — 路由依賴
 * - registerRegisterRoutes: 行 35 — 掛載 POST /api/auth/register
 * - handle()              : 行 45 — 註冊流程
 *
 * 流程順序刻意如此，為了「驗證失敗絕不消耗邀請碼配額」：
 *   1 主體型別 → 2 兩次密碼比對 → 3 用戶名與密碼政策（不碰 DB）
 *   → 4 邀請碼驗證 → 5 用戶名佔用預檢 → 6 建立使用者
 *   → 7 兌換邀請碼（失敗則刪除剛建立的使用者補償回捲）→ 8 簽發工作階段
 *
 * 安全不變量：
 * - 關閉模式下回傳與「路徑不存在」逐位元組相同的 404，探測者無從判斷端點是否存在。
 * - 邀請碼失敗一律回 invite_invalid，不區分「不存在／已撤銷／過期／用盡」。
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { RegistrationMode } from '../../config/schema.js';
import { createSession } from '../../auth/session.js';
import { createUser, prepareCredentials, UserCreationError } from '../../users/create.js';
import { redeemInviteCode, validateInviteCode } from '../../invite/code.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../cookies.js';
import { sendError } from '../errors.js';
import { asRecord, isNonEmptyString } from '../payload.js';

export interface RegisterDeps {
  prisma: PrismaClient;
  resolveMode: () => Promise<RegistrationMode>;
  secureCookie: boolean;
  rateLimitMax: number;
}

const RATE_WINDOW = '1 minute';

export function registerRegisterRoutes(app: FastifyInstance, deps: RegisterDeps): void {
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: deps.rateLimitMax, timeWindow: RATE_WINDOW } } },
    async (request, reply) => {
      const mode = await deps.resolveMode();
      if (mode === 'closed') return sendError(reply, 404, 'not_found');

      const body = asRecord(request.body);

      if (
        !isNonEmptyString(body.username) ||
        !isNonEmptyString(body.password) ||
        !isNonEmptyString(body.passwordConfirm)
      ) {
        return sendError(reply, 400, 'invalid_payload');
      }
      if (body.password !== body.passwordConfirm) {
        return sendError(reply, 400, 'password_mismatch');
      }

      let credentials;
      try {
        credentials = await prepareCredentials(body.username, body.password);
      } catch (error) {
        if (error instanceof UserCreationError) return sendError(reply, 400, error.code);
        throw error;
      }

      let grantedRole = 'user';
      let inviteCode: string | undefined;
      if (mode === 'invite') {
        if (!isNonEmptyString(body.inviteCode)) {
          return sendError(reply, 400, 'invite_required');
        }
        inviteCode = body.inviteCode.trim();
        const checked = await validateInviteCode(deps.prisma, inviteCode, {
          username: credentials.username,
        });
        if (!checked.ok) {
          const code =
            checked.reason === 'username_not_allowed'
              ? 'invite_username_not_allowed'
              : 'invite_invalid';
          return sendError(reply, 400, code);
        }
        grantedRole = checked.role;
      }

      const taken = await deps.prisma.user.findUnique({
        where: { username: credentials.username },
        select: { id: true },
      });
      if (taken) return sendError(reply, 409, 'username_taken');

      let user;
      try {
        user = await createUser(deps.prisma, credentials, grantedRole);
      } catch (error) {
        if (error instanceof UserCreationError) {
          return sendError(reply, error.code === 'username_taken' ? 409 : 400, error.code);
        }
        throw error;
      }

      if (inviteCode) {
        const redeemed = await redeemInviteCode(deps.prisma, {
          code: inviteCode,
          userId: user.id,
          username: credentials.username,
          ipAddress: request.ip,
        });
        if (!redeemed.ok) {
          await deps.prisma.user.delete({ where: { id: user.id } });
          return sendError(reply, 400, 'invite_invalid');
        }
      }

      const userAgent = request.headers['user-agent'];
      const session = await createSession(deps.prisma, {
        userId: user.id,
        ipAddress: request.ip,
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      });
      reply.setCookie(
        SESSION_COOKIE_NAME,
        session.token,
        sessionCookieOptions(session.expiresAt, deps.secureCookie),
      );
      return reply.status(201).send({ user });
    },
  );
}
