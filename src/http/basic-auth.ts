/**
 * Git CLI 的 Basic auth 認證。
 *
 * 功能位置：
 * - parseBasicAuth()   : 行 24 — 解析 Authorization 標頭，畸形輸入回 null
 * - authenticateBasic(): 行 41 — 帳號 + （密碼 | PAT）換取使用者
 *
 * git 命令行只會送 Basic auth，因此密碼欄位同時接受帳號密碼與 PAT。
 * PAT 必須屬於標頭中的帳號，否則視為認證失敗，避免拿別人的 token 冒用身分。
 */
import type { PrismaClient } from '@prisma/client';

import { verifyPassword } from '../auth/password.js';
import { resolveAccessToken } from '../auth/pat.js';
import type { AuthUser } from '../auth/principal.js';
import { AUTH_USER_SELECT } from '../auth/principal.js';

const BASIC_PREFIX = 'Basic ';

export interface BasicCredentials {
  password: string;
  username: string;
}

export function parseBasicAuth(header: string | undefined): BasicCredentials | null {
  if (!header?.startsWith(BASIC_PREFIX)) return null;

  const encoded = header.slice(BASIC_PREFIX.length).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export async function authenticateBasic(
  prisma: PrismaClient,
  header: string | undefined,
): Promise<AuthUser | null> {
  const credentials = parseBasicAuth(header);
  if (!credentials || credentials.password.length === 0) return null;

  const username = credentials.username.trim().toLowerCase();

  const byToken = await resolveAccessToken(prisma, credentials.password);
  if (byToken) return byToken.user.username === username ? byToken.user : null;

  // 單次查詢同時帶回雜湊與主體欄位，密碼路徑不再打第二輪資料庫。
  const found = await prisma.user.findUnique({
    where: { username },
    select: { ...AUTH_USER_SELECT, passwordHash: true },
  });
  if (!found) return null;

  const matched = await verifyPassword(found.passwordHash, credentials.password);
  if (!matched) return null;

  const { passwordHash: _stripped, ...user } = found;
  return user.isActive ? user : null;
}
