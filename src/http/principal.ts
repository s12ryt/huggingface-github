/**
 * 請求身分解析（HTTP 層共用）。
 *
 * 功能位置：
 * - readPrincipal()    : 行 24 — 先認 Authorization: Bearer 的 PAT，再認工作階段 cookie
 * - requirePrincipal() : 行 39 — 無身分即回 401 並中止
 * - requireAdmin()     : 行 52 — 非管理員即回 403 並中止
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { resolveAccessToken } from '../auth/pat.js';
import type { AuthUser } from '../auth/principal.js';
import { resolveSession } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import { sendError } from './errors.js';

const BEARER_PREFIX = 'Bearer ';

export const ADMIN_ROLE = 'admin';

export async function readPrincipal(
  prisma: PrismaClient,
  request: FastifyRequest,
): Promise<AuthUser | null> {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    const principal = await resolveAccessToken(prisma, header.slice(BEARER_PREFIX.length).trim());
    return principal?.user ?? null;
  }

  const token = request.cookies[SESSION_COOKIE_NAME];
  if (typeof token !== 'string' || token.length === 0) return null;
  const principal = await resolveSession(prisma, token);
  return principal?.user ?? null;
}

export async function requirePrincipal(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthUser | null> {
  const user = await readPrincipal(prisma, request);
  if (!user) {
    await sendError(reply, 401, 'unauthenticated');
    return null;
  }
  return user;
}

export async function requireAdmin(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthUser | null> {
  const user = await requirePrincipal(prisma, request, reply);
  if (!user) return null;
  if (user.role !== ADMIN_ROLE) {
    await sendError(reply, 403, 'forbidden');
    return null;
  }
  return user;
}
