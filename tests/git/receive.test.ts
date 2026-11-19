/**
 * applyCommands 契約：條件式 ref 更新（樂觀鎖語意）與零預先點查。
 *
 * - 建立／更新／刪除／stale 行為錨定
 * - 併發建立碰撞（P2002）回 stale
 * - 更新路徑不得先 findUnique（讀改寫有 TOCTOU 競態，條件式寫入直接排除）
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { applyCommands } from '@/git/receive.js';
import { ZERO_OID } from '@/git/protocol.js';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { seedUser } from '../helpers/auth.js';

let db: TestDb;
let prisma: PrismaClient;
let repoId = '';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

beforeAll(async () => {
  db = createTestDb();
  prisma = db.prisma;
  const owner = await seedUser(prisma, 'recv-owner');
  repoId = (
    await prisma.repo.create({
      data: { name: 'sink', ownerId: owner.id, storagePath: '/repos/recv-owner/sink' },
    })
  ).id;
});

afterAll(async () => {
  await db.close();
});

async function setRef(name: string, oid: string | null): Promise<void> {
  await prisma.repoRef.deleteMany({ where: { repoId, name } });
  if (oid !== null) {
    await prisma.repoRef.create({ data: { repoId, name, targetOid: oid } });
  }
}

describe('applyCommands 行為', () => {
  it('old 為零值時建立新 ref', async () => {
    const [result] = await applyCommands(prisma, repoId, [
      { name: 'refs/heads/new', newOid: A, oldOid: ZERO_OID },
    ]);
    expect(result?.ok).toBe(true);
    await expect(
      prisma.repoRef.findUniqueOrThrow({
        where: { repoId_name: { repoId, name: 'refs/heads/new' } },
      }),
    ).resolves.toMatchObject({ targetOid: A });
  });

  it('old 吻合時條件更新', async () => {
    await setRef('refs/heads/main', A);
    const [result] = await applyCommands(prisma, repoId, [
      { name: 'refs/heads/main', newOid: B, oldOid: A },
    ]);
    expect(result?.ok).toBe(true);
    await expect(
      prisma.repoRef.findUniqueOrThrow({
        where: { repoId_name: { repoId, name: 'refs/heads/main' } },
      }),
    ).resolves.toMatchObject({ targetOid: B });
  });

  it('old 不符時回 stale info 且不覆寫', async () => {
    await setRef('refs/heads/main', B);
    const [result] = await applyCommands(prisma, repoId, [
      { name: 'refs/heads/main', newOid: A, oldOid: A },
    ]);
    expect(result?.ok).toBe(false);
    expect(result?.reason).toBe('stale info');
    await expect(
      prisma.repoRef.findUniqueOrThrow({
        where: { repoId_name: { repoId, name: 'refs/heads/main' } },
      }),
    ).resolves.toMatchObject({ targetOid: B });
  });

  it('new 為零值時刪除現存 ref', async () => {
    await setRef('refs/heads/gone', A);
    const [result] = await applyCommands(prisma, repoId, [
      { name: 'refs/heads/gone', newOid: ZERO_OID, oldOid: A },
    ]);
    expect(result?.ok).toBe(true);
    await expect(prisma.repoRef.count({ where: { repoId, name: 'refs/heads/gone' } })).resolves.toBe(0);
  });

  it('刪除不存在的 ref（old 與 new 皆零值）維持冪等成功', async () => {
    const [result] = await applyCommands(prisma, repoId, [
      { name: 'refs/heads/ghost', newOid: ZERO_OID, oldOid: ZERO_OID },
    ]);
    expect(result?.ok).toBe(true);
  });

  it('併發建立碰撞（P2002）回 stale 而非失敗', async () => {
    await setRef('refs/heads/race', A);
    // Prisma model method 的 vi.spyOn 還原不可靠，手動替換並保證還原。
    const model = prisma.repoRef as unknown as { create: typeof prisma.repoRef.create };
    const original = model.create;
    model.create = (() => Promise.reject({ code: 'P2002' })) as unknown as typeof original;
    try {
      const [result] = await applyCommands(prisma, repoId, [
        { name: 'refs/heads/race', newOid: B, oldOid: ZERO_OID },
      ]);
      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('stale info');
    } finally {
      model.create = original;
    }
    await expect(
      prisma.repoRef.findUniqueOrThrow({
        where: { repoId_name: { repoId, name: 'refs/heads/race' } },
      }),
    ).resolves.toMatchObject({ targetOid: A });
  });
});

describe('applyCommands 查詢足跡', () => {
  it('全程不做預先點查（條件式寫入取代讀改寫）', async () => {
    await setRef('refs/heads/c1', A);
    await setRef('refs/heads/c2', A);
    const model = prisma.repoRef as unknown as {
      findUnique: typeof prisma.repoRef.findUnique;
    };
    const original = model.findUnique as unknown as (...args: unknown[]) => unknown;
    let calls = 0;
    model.findUnique = (async (...args: unknown[]) => {
      calls += 1;
      return original(...args);
    }) as typeof prisma.repoRef.findUnique;
    try {
      const results = await applyCommands(prisma, repoId, [
        { name: 'refs/heads/c0', newOid: A, oldOid: ZERO_OID },
        { name: 'refs/heads/c1', newOid: B, oldOid: A },
        { name: 'refs/heads/c2', newOid: B, oldOid: B },
        { name: 'refs/heads/c1', newOid: ZERO_OID, oldOid: B },
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
      expect(calls).toBe(0);
    } finally {
      model.findUnique = original as unknown as typeof prisma.repoRef.findUnique;
    }
  });
});
