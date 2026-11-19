/**
 * src/auth/pat.ts — 個人存取權杖（Git over HTTPS 與 API 認證用）（階段 3）
 *
 * 1~45    PAT_SCOPES / DEFAULT_PAT_SCOPES、InvalidScopeError、DuplicateTokenNameError
 * 46~65   normalizeScopes：驗證、去重、以固定順序序列化
 * 66~100  issueAccessToken：DB 僅存雜湊與顯示前綴
 * 101~135 resolveAccessToken：撤銷/過期/停用皆回 null，lastUsedAt 節流更新
 * 136~    revokeAccessToken（軟撤銷、綁定 userId）、listAccessTokens、hasScope
 */
import type { PrismaClient } from '@prisma/client';
import { AUTH_USER_SELECT, type AuthUser } from './principal.js';
import { PAT_TOKEN_PREFIX, createSecretToken, hashSecretToken } from './tokens.js';

export const PAT_SCOPES = ['repo', 'admin'] as const;
export type PatScope = (typeof PAT_SCOPES)[number];
export const DEFAULT_PAT_SCOPES: readonly PatScope[] = ['repo'];

const SCOPE_SEPARATOR = ',';

/** lastUsedAt 的更新節流窗：窗內重複驗證不重寫，避免每個請求都產生一次 DB 寫入。 */
export const PAT_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export class InvalidScopeError extends Error {
  constructor(scope: string) {
    super(`Unknown scope "${scope}". Allowed scopes: ${PAT_SCOPES.join(', ')}`);
    this.name = 'InvalidScopeError';
  }
}

export class DuplicateTokenNameError extends Error {
  constructor(name: string) {
    super(`A token named "${name}" already exists for this user`);
    this.name = 'DuplicateTokenNameError';
  }
}

export interface IssueTokenOptions {
  userId: string;
  name: string;
  scopes?: readonly string[];
  expiresAt?: Date;
  now?: Date;
}

export interface IssuedAccessToken {
  id: string;
  token: string;
  displayPrefix: string;
  scopes: PatScope[];
  expiresAt: Date | null;
}

export interface AccessTokenPrincipal {
  tokenId: string;
  user: AuthUser;
  scopes: PatScope[];
}

export interface AccessTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: PatScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function normalizeScopes(input: readonly string[]): PatScope[] {
  for (const scope of input) {
    if (!PAT_SCOPES.includes(scope as PatScope)) throw new InvalidScopeError(scope);
  }
  return PAT_SCOPES.filter((scope) => input.includes(scope));
}

function parseScopes(stored: string): PatScope[] {
  const parts = stored.split(SCOPE_SEPARATOR);
  return PAT_SCOPES.filter((scope) => parts.includes(scope));
}

export async function issueAccessToken(
  prisma: PrismaClient,
  options: IssueTokenOptions,
): Promise<IssuedAccessToken> {
  const scopes = normalizeScopes(options.scopes ?? DEFAULT_PAT_SCOPES);
  const { token, tokenHash, displayPrefix } = createSecretToken(PAT_TOKEN_PREFIX);
  const expiresAt = options.expiresAt ?? null;
  try {
    const row = await prisma.personalAccessToken.create({
      data: {
        userId: options.userId,
        name: options.name,
        tokenHash,
        tokenPrefix: displayPrefix,
        scopes: scopes.join(SCOPE_SEPARATOR),
        expiresAt,
        createdAt: options.now ?? new Date(),
      },
      select: { id: true },
    });
    return { id: row.id, token, displayPrefix, scopes, expiresAt };
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002')
      throw new DuplicateTokenNameError(options.name);
    throw error;
  }
}

export async function resolveAccessToken(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<AccessTokenPrincipal | null> {
  if (token.length === 0) return null;
  const row = await prisma.personalAccessToken.findUnique({
    where: { tokenHash: hashSecretToken(token) },
    select: {
      id: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      user: { select: AUTH_USER_SELECT },
    },
  });
  if (row === null || row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.user.isActive) return null;
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= PAT_LAST_USED_THROTTLE_MS) {
    await prisma.personalAccessToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  }
  return { tokenId: row.id, user: row.user, scopes: parseScopes(row.scopes) };
}

export async function revokeAccessToken(
  prisma: PrismaClient,
  target: { userId: string; tokenId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const result = await prisma.personalAccessToken.updateMany({
    where: { id: target.tokenId, userId: target.userId, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count > 0;
}

export async function listAccessTokens(
  prisma: PrismaClient,
  userId: string,
): Promise<AccessTokenSummary[]> {
  const rows = await prisma.personalAccessToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({ ...row, scopes: parseScopes(row.scopes) }));
}

export function hasScope(scopes: readonly PatScope[], required: PatScope): boolean {
  return scopes.includes('admin') || scopes.includes(required);
}
