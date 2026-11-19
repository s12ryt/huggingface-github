/**
 * src/auth/password.ts — 密碼雜湊與驗證（階段 3）
 *
 * 1~30  PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH 政策常數
 * 31~45 PasswordPolicyError：政策違反時拋出，訊息永不含密碼明文
 * 46~60 hashPassword：argon2id 雜湊，每次自動加鹽
 * 61~   verifyPassword：任何畸形輸入皆回 false 而不拋錯
 */
import { hash, verify } from '@node-rs/argon2';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** OWASP 建議參數（19 MiB、2 輪、單執行緒）；演算法不指定，沿用函式庫預設的 argon2id。 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class PasswordPolicyError extends Error {
  constructor(reason: string) {
    super(`Password rejected: ${reason}`);
    this.name = 'PasswordPolicyError';
  }
}

function assertPolicy(plain: string): void {
  if (plain.trim().length === 0) throw new PasswordPolicyError('must not be blank');
  if (plain.length < PASSWORD_MIN_LENGTH)
    throw new PasswordPolicyError(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (plain.length > PASSWORD_MAX_LENGTH)
    throw new PasswordPolicyError(`must be at most ${PASSWORD_MAX_LENGTH} characters`);
}

export async function hashPassword(plain: string): Promise<string> {
  assertPolicy(plain);
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  if (hashed.length === 0 || plain.length === 0) return false;
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
