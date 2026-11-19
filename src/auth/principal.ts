/**
 * src/auth/principal.ts — 認證主體的共用投影（階段 3）
 *
 * 1~25 AUTH_USER_SELECT：Prisma select 白名單，結構性保證 passwordHash 永不離開資料層
 * 26~  AuthUser：session 與 PAT 共用的使用者型別
 */
import type { User } from '@prisma/client';

export const AUTH_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  mustChangePassword: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AuthUser = Omit<User, 'passwordHash'>;
