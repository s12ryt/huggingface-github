// src/invite/code.ts
// 邀請碼的簽發、驗證與兌換。
// 14~16 : INVITE_CODE_PREFIX
// 18~34 : 結果型別
// 36~60 : createInviteCode — 只回明文一次，資料庫僅存 sha256
// 62~96 : validateInviteCode — 無效原因一律合併為 invalid 以防枚舉
// 98~146: redeemInviteCode — 單語句原子遞增 + 失敗補償，併發不超賣

import type { PrismaClient } from '@prisma/client';
import { createSecretToken, hashSecretToken, tokenDisplayPrefix } from '../auth/tokens.js';
import { matchesUsernamePattern, normalizeCreateParams } from './params.js';
import type { CreateInviteParams } from './params.js';

export { INVITE_ROLES, InviteParamError } from './params.js';
export { listInviteCodes, revokeInviteCode } from './admin.js';
export type { InviteCodeSummary } from './admin.js';

export const INVITE_CODE_PREFIX = 'odgi';

export interface IssuedInviteCode {
  id: string;
  code: string;
  codePrefix: string;
}

export type InviteFailureReason = 'invalid' | 'username_not_allowed';

export type ValidateInviteResult =
  | { ok: true; id: string; role: string }
  | { ok: false; reason: InviteFailureReason };

export type RedeemInviteResult = { ok: true; id: string; role: string } | { ok: false; reason: 'invalid' };

export interface ValidateOptions {
  username: string;
  now?: Date;
}

export interface RedeemOptions {
  code: string;
  userId: string;
  username?: string;
  ipAddress?: string;
  now?: Date;
}

export async function createInviteCode(
  prisma: PrismaClient,
  params: CreateInviteParams,
): Promise<IssuedInviteCode> {
  const normalized = normalizeCreateParams(params);
  const secret = createSecretToken(INVITE_CODE_PREFIX);
  const codePrefix = tokenDisplayPrefix(secret.token);

  const row = await prisma.inviteCode.create({
    data: {
      codeHash: secret.tokenHash,
      codePrefix,
      createdById: params.createdById,
      role: normalized.role,
      maxUses: normalized.maxUses,
      expiresAt: normalized.expiresAt,
      note: normalized.note,
      usernamePattern: normalized.usernamePattern,
    },
    select: { id: true },
  });

  return { id: row.id, code: secret.token, codePrefix };
}

/** 查詢邀請碼並判斷可用性。不存在、撤銷、過期、用盡一律回同一個 invalid。 */
export async function validateInviteCode(
  prisma: PrismaClient,
  code: string,
  options: ValidateOptions,
): Promise<ValidateInviteResult> {
  const trimmed = code.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'invalid' };

  const row = await prisma.inviteCode.findUnique({
    where: { codeHash: hashSecretToken(trimmed) },
    select: {
      id: true,
      role: true,
      maxUses: true,
      usedCount: true,
      expiresAt: true,
      revokedAt: true,
      usernamePattern: true,
    },
  });

  const now = options.now ?? new Date();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revokedAt !== null) return { ok: false, reason: 'invalid' };
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.usedCount >= row.maxUses) return { ok: false, reason: 'invalid' };
  if (!matchesUsernamePattern(row.usernamePattern, options.username)) {
    return { ok: false, reason: 'username_not_allowed' };
  }

  return { ok: true, id: row.id, role: row.role };
}

/**
 * 兌換邀請碼。使用單一 UPDATE 語句的 usedCount < maxUses 條件搶佔配額，
 * 讓併發請求由資料庫序列化；使用紀錄寫入失敗時回補配額，避免名額遺失。
 */
export async function redeemInviteCode(
  prisma: PrismaClient,
  options: RedeemOptions,
): Promise<RedeemInviteResult> {
  const checked = await validateInviteCode(prisma, options.code, {
    username: options.username ?? '',
    ...(options.now ? { now: options.now } : {}),
  });
  if (!checked.ok) return { ok: false, reason: 'invalid' };

  const claimed = await prisma.$executeRaw`
    UPDATE "InviteCode"
    SET "usedCount" = "usedCount" + 1
    WHERE "id" = ${checked.id}
      AND "revokedAt" IS NULL
      AND "usedCount" < "maxUses"`;
  if (claimed === 0) return { ok: false, reason: 'invalid' };

  try {
    await prisma.inviteCodeUse.create({
      data: {
        inviteCodeId: checked.id,
        userId: options.userId,
        ...(options.ipAddress ? { ipAddress: options.ipAddress } : {}),
      },
    });
  } catch {
    await prisma.$executeRaw`
      UPDATE "InviteCode"
      SET "usedCount" = "usedCount" - 1
      WHERE "id" = ${checked.id} AND "usedCount" > 0`;
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, id: checked.id, role: checked.role };
}
