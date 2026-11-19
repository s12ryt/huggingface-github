/**
 * Basic auth（git CLI）認證效率：密碼路徑只查一次資料庫。
 * 安全不變量：回傳主體不得攜帶 passwordHash。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb, type TestDb } from '../helpers/db.js';
import { authenticateBasic } from '@/http/basic-auth.js';
import { seedUser, TEST_PASSWORD } from '../helpers/auth.js';

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = createTestDb();
  prisma = db.prisma;
  await seedUser(prisma, 'basic-user');
});

afterAll(async () => {
  await db.close();
});

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

describe('密碼認證單查詢', () => {
  it('帳號密碼通過認證', async () => {
    const user = await authenticateBasic(prisma, basicHeader('basic-user', TEST_PASSWORD));
    expect(user?.username).toBe('basic-user');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('錯誤密碼回 null', async () => {
    await expect(
      authenticateBasic(prisma, basicHeader('basic-user', 'wrong-password')),
    ).resolves.toBeNull();
  });

  // spy 測試放最後：Prisma model method 經 vi.spyOn+mockRestore 後不保證可還原。
  it('密碼路徑只發出一次 user 查詢', async () => {
    const find = prisma.user.findUnique.bind(prisma.user);
    let calls = 0;
    const spy = vi.spyOn(prisma.user, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof find>) => {
        calls += 1;
        return find(...args);
      }) as unknown as typeof prisma.user.findUnique,
    );
    const user = await authenticateBasic(prisma, basicHeader('basic-user', TEST_PASSWORD));
    expect(user?.username).toBe('basic-user');
    expect(calls).toBe(1);
    spy.mockRestore();
  });
});
