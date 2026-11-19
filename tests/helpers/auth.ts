// 測試輔助：HTTP 層的身分建置
//   seedUser    — 建立具真實 argon2 雜湊的使用者（第 17 行）
//   loginCookie — 以帳密登入並取出 session cookie 字串（第 26 行）
//   bearer      — 組裝 PAT 的 Authorization header（第 36 行）
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/auth/password.js';

export const TEST_PASSWORD = 'password123';

export interface SeededUser {
  id: string;
  username: string;
  role: string;
}

export async function seedUser(
  prisma: PrismaClient,
  username: string,
  role = 'user',
  password = TEST_PASSWORD,
): Promise<SeededUser> {
  return prisma.user.create({
    data: { username, passwordHash: await hashPassword(password), role },
    select: { id: true, username: true, role: true },
  });
}

export async function loginCookie(
  app: FastifyInstance,
  username: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const cookie = response.cookies.find((entry) => entry.name === 'odg_session');
  if (!cookie) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return `odg_session=${cookie.value}`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
