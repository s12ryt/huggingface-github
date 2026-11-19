/**
 * 使用者建立服務。
 * - UserCreationError：以錯誤碼表達拒絕原因（第 20 行）
 * - prepareCredentials：先驗證名稱與密碼，確保失敗時不觸碰資料庫（第 33 行）
 * - createUser：寫入使用者並把唯一鍵衝突轉為 username_taken（第 48 行）
 */
import type { PrismaClient } from '@prisma/client';

import { hashPassword, PasswordPolicyError } from '../auth/password.js';

import { normalizeUsername, UsernameError, type UsernameErrorCode } from './username.js';

export type CreateUserErrorCode = UsernameErrorCode | 'weak_password' | 'username_taken';

export interface NewUser {
  id: string;
  username: string;
  role: string;
}

export class UserCreationError extends Error {
  constructor(readonly code: CreateUserErrorCode) {
    super(`User rejected: ${code}`);
    this.name = 'UserCreationError';
  }
}

export interface PreparedCredentials {
  username: string;
  passwordHash: string;
}

/** 名稱與密碼都通過後才回傳雜湊，讓呼叫端能在落庫前中止流程。 */
export async function prepareCredentials(
  rawUsername: unknown,
  password: string,
): Promise<PreparedCredentials> {
  let username: string;
  try {
    username = normalizeUsername(rawUsername);
  } catch (error) {
    if (error instanceof UsernameError) throw new UserCreationError(error.code);
    throw error;
  }

  try {
    return { username, passwordHash: await hashPassword(password) };
  } catch (error) {
    if (error instanceof PasswordPolicyError) throw new UserCreationError('weak_password');
    throw error;
  }
}

export async function createUser(
  prisma: PrismaClient,
  credentials: PreparedCredentials,
  role = 'user',
): Promise<NewUser> {
  try {
    return await prisma.user.create({
      data: { username: credentials.username, passwordHash: credentials.passwordHash, role },
      select: { id: true, username: true, role: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new UserCreationError('username_taken');
    }
    throw error;
  }
}
