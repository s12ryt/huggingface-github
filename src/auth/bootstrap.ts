// src/auth/bootstrap.ts
// 管理員種子帳號與改密。
// 18~24 : 預設帳密常數（admin / s12ryt-huggingface-github）
// 26~33 : 回傳型別
// 35~61 : ensureAdminAccount — 首啟建立、冪等、絕不覆寫既有帳號
// 63~82 : changePassword — 改密、解除強制改密、撤銷所有工作階段

import type { PrismaClient } from '@prisma/client';
import { hashPassword } from './password.js';

export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 's12ryt-huggingface-github';

export interface EnsureAdminOptions {
  username?: string;
  password?: string;
}

export interface EnsureAdminResult {
  created: boolean;
  userId: string;
  username: string;
}

/**
 * 確保管理員帳號存在。已存在時原樣返回，不重設密碼、不改啟用狀態、
 * 不動 mustChangePassword — 避免種子程序成為密碼重設後門。
 */
export async function ensureAdminAccount(
  prisma: PrismaClient,
  options: EnsureAdminOptions = {},
): Promise<EnsureAdminResult> {
  const username = options.username ?? DEFAULT_ADMIN_USERNAME;
  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });

  if (existing) {
    return { created: false, userId: existing.id, username };
  }

  const passwordHash = await hashPassword(options.password ?? DEFAULT_ADMIN_PASSWORD);
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      role: 'admin',
      mustChangePassword: true,
      isActive: true,
    },
    select: { id: true },
  });

  return { created: true, userId: user.id, username };
}

/** 改密：政策檢查先行，成功後解除強制改密並撤銷所有既有工作階段。 */
export async function changePassword(
  prisma: PrismaClient,
  username: string,
  newPassword: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) return false;
  // 先確認帳號存在才付出 argon2 成本；雜湊與交易寫入互不依賴順序以外的事實。
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);

  return true;
}
