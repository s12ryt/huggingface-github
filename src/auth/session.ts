/**
 * src/auth/session.ts — 瀏覽器 session 的簽發、驗證、撤銷（階段 3）
 *
 * 1~35   DEFAULT_SESSION_TTL_MS 與型別定義
 * 36~60  createSession：只回傳一次明文 token，DB 僅存雜湊
 * 61~90  resolveSession：過期即刪、帳號停用即失效、lastSeenAt 節流更新
 * 91~    revokeSession / revokeAllSessions / pruneExpiredSessions
 */
import type { PrismaClient } from '@prisma/client';
import { AUTH_USER_SELECT, type AuthUser } from './principal.js';
import { SESSION_TOKEN_PREFIX, createSecretToken, hashSecretToken } from './tokens.js';

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** lastSeenAt 的更新節流窗：窗內重複驗證不重寫，避免每個請求都產生一次 DB 寫入。 */
export const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export interface CreateSessionOptions {
  userId: string;
  ttlMs?: number;
  userAgent?: string;
  ipAddress?: string;
  now?: Date;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export interface SessionPrincipal {
  sessionId: string;
  user: AuthUser;
}

export async function createSession(
  prisma: PrismaClient,
  options: CreateSessionOptions,
): Promise<IssuedSession> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_SESSION_TTL_MS));
  const { token, tokenHash } = createSecretToken(SESSION_TOKEN_PREFIX);
  const row = await prisma.session.create({
    data: {
      userId: options.userId,
      tokenHash,
      expiresAt,
      userAgent: options.userAgent ?? null,
      ipAddress: options.ipAddress ?? null,
      createdAt: now,
      lastSeenAt: now,
    },
    select: { id: true },
  });
  return { token, sessionId: row.id, expiresAt };
}

export async function resolveSession(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<SessionPrincipal | null> {
  if (token.length === 0) return null;
  const row = await prisma.session.findUnique({
    where: { tokenHash: hashSecretToken(token) },
    select: { id: true, expiresAt: true, lastSeenAt: true, user: { select: AUTH_USER_SELECT } },
  });
  if (row === null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await prisma.session.deleteMany({ where: { id: row.id } });
    return null;
  }
  if (!row.user.isActive) return null;
  if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
    await prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: now } });
  }
  return { sessionId: row.id, user: row.user };
}

export async function revokeSession(prisma: PrismaClient, token: string): Promise<boolean> {
  if (token.length === 0) return false;
  const result = await prisma.session.deleteMany({
    where: { tokenHash: hashSecretToken(token) },
  });
  return result.count > 0;
}

export async function revokeAllSessions(prisma: PrismaClient, userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { userId } });
  return result.count;
}

export async function pruneExpiredSessions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}
