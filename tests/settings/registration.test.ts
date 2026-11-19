/**
 * 註冊模式快取測試：讀取路徑不打重複 DB 查詢、寫入後立即生效、不同 prisma 實例不互染。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  REGISTRATION_MODE_KEY,
  readRegistrationMode,
  writeRegistrationMode,
} from '@/settings/registration.js';

let db: TestDb;
let prisma: PrismaClient;

beforeAll(() => {
  db = createTestDb();
  prisma = db.prisma;
});

afterAll(async () => {
  await db.close();
});

describe('讀取快取', () => {
  it('寫入後快取失效，讀到新模式', async () => {
    await writeRegistrationMode(prisma, 'open');
    await expect(readRegistrationMode(prisma, 'closed')).resolves.toBe('open');
    await writeRegistrationMode(prisma, 'invite');
    await expect(readRegistrationMode(prisma, 'closed')).resolves.toBe('invite');
  });

  it('不同 prisma 實例不共用快取', async () => {
    const other = createTestDb();
    try {
      await writeRegistrationMode(prisma, 'open');
      await expect(readRegistrationMode(other.prisma, 'closed')).resolves.toBe('closed');
      await expect(other.prisma.setting.findUnique({ where: { key: REGISTRATION_MODE_KEY } }))
        .resolves.toBeNull();
    } finally {
      await other.close();
    }
  });

  // spy 測試放在檔尾：mockRestore 對 Prisma model 方法不保證可還原。
  it('同一 prisma 連續讀取只查詢一次', async () => {
    await writeRegistrationMode(prisma, 'invite');
    const find = prisma.setting.findUnique.bind(prisma.setting);
    let calls = 0;
    const spy = vi.spyOn(prisma.setting, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof find>) => {
        calls += 1;
        return find(...args);
      }) as unknown as typeof prisma.setting.findUnique,
    );
    try {
      const first = await readRegistrationMode(prisma, 'closed');
      const second = await readRegistrationMode(prisma, 'closed');
      expect(first).toBe('invite');
      expect(second).toBe('invite');
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
