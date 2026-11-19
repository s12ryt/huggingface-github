/**
 * tests/auth/password.test.ts — 密碼雜湊驗收測試（階段 3）
 *
 * 1~30  密碼政策：長度下限/上限、空白密碼拒絕
 * 31~70 雜湊格式：argon2id 前綴、每次加鹽不同
 * 71~110 驗證：正確/錯誤/畸形雜湊不得拋錯
 * 111~  不洩漏：錯誤訊息不得含密碼明文
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  hashPassword,
  verifyPassword,
} from '@/auth/password.js';

const VALID = 's12ryt-huggingface-github';

describe('密碼政策', () => {
  it('下限與上限為合理且明確的常數', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
  });

  it('短於下限的密碼拒絕雜湊', async () => {
    await expect(hashPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).rejects.toBeInstanceOf(
      PasswordPolicyError,
    );
  });

  it('長度剛好等於下限可通過', async () => {
    await expect(hashPassword('a'.repeat(PASSWORD_MIN_LENGTH))).resolves.toBeTypeOf('string');
  });

  it('超過上限的密碼拒絕雜湊，避免雜湊運算被當成 DoS 向量', async () => {
    await expect(hashPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toBeInstanceOf(
      PasswordPolicyError,
    );
  });

  it('純空白密碼視為空密碼而拒絕', async () => {
    await expect(hashPassword('          ')).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it('政策錯誤訊息不得包含密碼明文', async () => {
    const secret = 'short-1';
    await expect(hashPassword(secret)).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes(secret),
    );
  });
});

describe('雜湊格式', () => {
  it('產生 argon2id 雜湊', async () => {
    const hash = await hashPassword(VALID);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('雜湊結果絕不包含密碼明文', async () => {
    const hash = await hashPassword(VALID);
    expect(hash.includes(VALID)).toBe(false);
  });

  it('同一密碼兩次雜湊結果不同（每次加鹽）', async () => {
    const [a, b] = await Promise.all([hashPassword(VALID), hashPassword(VALID)]);
    expect(a).not.toBe(b);
  });
});

describe('密碼驗證', () => {
  it('正確密碼回 true', async () => {
    const hash = await hashPassword(VALID);
    await expect(verifyPassword(hash, VALID)).resolves.toBe(true);
  });

  it('錯誤密碼回 false', async () => {
    const hash = await hashPassword(VALID);
    await expect(verifyPassword(hash, `${VALID}x`)).resolves.toBe(false);
  });

  it('大小寫不同視為錯誤密碼', async () => {
    const hash = await hashPassword(VALID);
    await expect(verifyPassword(hash, VALID.toUpperCase())).resolves.toBe(false);
  });

  it('畸形雜湊回 false 而不拋錯', async () => {
    await expect(verifyPassword('not-a-hash', VALID)).resolves.toBe(false);
  });

  it('空雜湊回 false 而不拋錯', async () => {
    await expect(verifyPassword('', VALID)).resolves.toBe(false);
  });

  it('空密碼對合法雜湊回 false 而不拋錯', async () => {
    const hash = await hashPassword(VALID);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });
});
