// src/invite/admin.ts
// 邀請碼的管理面操作。
// 10~20 : 列表回傳型別（結構性排除 codeHash）
// 22~32 : revokeInviteCode — 軟撤銷保留審計軌跡
// 34~48 : listInviteCodes — 白名單欄位

import type { PrismaClient } from '@prisma/client';

export interface InviteCodeSummary {
  id: string;
  codePrefix: string;
  role: string;
  maxUses: number;
  usedCount: number;
  expiresAt: Date | null;
  note: string | null;
  usernamePattern: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdById: string;
}

/** 軟撤銷：寫入 revokedAt 而不刪列。已撤銷或不存在皆回 false。 */
export async function revokeInviteCode(prisma: PrismaClient, id: string): Promise<boolean> {
  const result = await prisma.inviteCode.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}

export async function listInviteCodes(prisma: PrismaClient): Promise<InviteCodeSummary[]> {
  return prisma.inviteCode.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      codePrefix: true,
      role: true,
      maxUses: true,
      usedCount: true,
      expiresAt: true,
      note: true,
      usernamePattern: true,
      revokedAt: true,
      createdAt: true,
      createdById: true,
    },
  });
}
