// src/invite/params.ts
// 邀請碼可配置參數的驗證與正規化。
// 11~14 : 合法角色清單
// 16~24 : InviteParamError
// 26~34 : 建立參數型別
// 36~70 : normalizeCreateParams — 角色/次數/有效期/用戶名規則四項守門

export const INVITE_ROLES = ['user', 'admin'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export class InviteParamError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid invite parameter: ${field} ${reason}`);
    this.name = 'InviteParamError';
  }
}

export interface CreateInviteParams {
  createdById: string;
  role?: string;
  maxUses?: number;
  expiresAt?: Date | null;
  note?: string | null;
  usernamePattern?: string | null;
}

export interface NormalizedInviteParams {
  role: InviteRole;
  maxUses: number;
  expiresAt: Date | null;
  note: string | null;
  usernamePattern: string | null;
}

/** 驗證後回傳可直接寫入資料庫的參數，任何非法輸入一律拋錯而非默默修正。 */
export function normalizeCreateParams(
  params: CreateInviteParams,
  now: Date = new Date(),
): NormalizedInviteParams {
  const role = params.role ?? 'user';
  if (!INVITE_ROLES.includes(role as InviteRole)) {
    throw new InviteParamError('role', `must be one of ${INVITE_ROLES.join(', ')}`);
  }

  const maxUses = params.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    throw new InviteParamError('maxUses', 'must be a positive integer');
  }

  const expiresAt = params.expiresAt ?? null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw new InviteParamError('expiresAt', 'must be in the future');
  }

  const usernamePattern = params.usernamePattern ?? null;
  if (usernamePattern !== null) {
    try {
      new RegExp(usernamePattern);
    } catch {
      throw new InviteParamError('usernamePattern', 'is not a valid regular expression');
    }
  }

  return {
    role: role as InviteRole,
    maxUses,
    expiresAt,
    note: params.note ?? null,
    usernamePattern,
  };
}

/** 用戶名是否符合該邀請碼綁定的規則；無規則視為允許。 */
export function matchesUsernamePattern(pattern: string | null, username: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(username);
  } catch {
    return false;
  }
}
