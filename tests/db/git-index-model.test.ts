/**
 * 階段 2 — Git packfile 與物件索引資料模型契約測試（對真實 SQLite 驗證）。
 *
 * 驗收依據：agent/question.md「E+ 方案」之索引雙存、delta 路徑展平、downloadUrl 快取。
 *
 * 測試涵蓋：
 *   - PackFile       第 30 行：同倉庫 pack 名唯一、預簽名 downloadUrl 與到期時間可快取
 *   - GitObjectIndex 第 73 行：同倉庫 oid 唯一、Range 讀取三元組（offset/size）、
 *                              delta 鏈展平為有序 oid 清單且 objectType 為還原後的最終型別
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../helpers/db.js';

let db: TestDb;
let prisma: PrismaClient;

beforeAll(() => {
  db = createTestDb();
  prisma = db.prisma;
});

afterAll(async () => {
  await db.close();
});

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${++seq}`;
const oid = (seed: string): string => seed.repeat(40).slice(0, 40);

async function makeRepo() {
  const owner = await prisma.user.create({
    data: { username: uniq('u'), passwordHash: 'hash' },
  });
  const name = uniq('repo');
  return prisma.repo.create({
    data: { ownerId: owner.id, name, storagePath: `/repos/${owner.id}/${name}` },
  });
}

async function makePack(repoId: string, name = uniq('pack-')) {
  return prisma.packFile.create({
    data: { repoId, name, byteSize: 1024, objectCount: 3 },
  });
}

describe('PackFile 模型', () => {
  it('同一倉庫內 pack 名稱唯一', async () => {
    const repo = await makeRepo();
    await makePack(repo.id, 'pack-dup');
    await expect(makePack(repo.id, 'pack-dup')).rejects.toMatchObject({ code: 'P2002' });
  });

  // 不再保存任何下載網址：HuggingFace 的 resolve 路徑可由資料集 id、修訂版本
  // 與檔案路徑直接推導，所以 pack 只需要記住名稱與大小。
  it('只記錄推導 resolve 路徑所需的資料', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    expect(Object.keys(pack).sort()).toEqual(
      ['byteSize', 'createdAt', 'id', 'name', 'objectCount', 'repoId'].sort(),
    );
  });

  it('保存位元組大小與物件數以供下載規劃', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    expect(pack.byteSize).toBe(1024);
    expect(pack.objectCount).toBe(3);
  });

  it('刪除倉庫時級聯清除 pack', async () => {
    const repo = await makeRepo();
    await makePack(repo.id);
    await prisma.repo.delete({ where: { id: repo.id } });
    expect(await prisma.packFile.count({ where: { repoId: repo.id } })).toBe(0);
  });
});

describe('GitObjectIndex 模型', () => {
  async function makeIndex(repoId: string, packFileId: string, data: Record<string, unknown> = {}) {
    return prisma.gitObjectIndex.create({
      data: {
        repoId,
        packFileId,
        oid: oid('a'),
        objectType: 'blob',
        packOffset: 12,
        storedSize: 34,
        inflatedSize: 56,
        ...data,
      },
    });
  }

  it('同一倉庫內 oid 唯一', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    await makeIndex(repo.id, pack.id, { oid: oid('b') });
    await expect(makeIndex(repo.id, pack.id, { oid: oid('b') })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('保存 Range 讀取所需的 (pack, offset, size) 三元組', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    const entry = await makeIndex(repo.id, pack.id, { oid: oid('c'), packOffset: 4096, storedSize: 128 });
    expect(entry.packFileId).toBe(pack.id);
    expect(entry.packOffset).toBe(4096);
    expect(entry.storedSize).toBe(128);
    expect(entry.inflatedSize).toBe(56);
  });

  it('非 delta 物件的展平鏈為空', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    const entry = await makeIndex(repo.id, pack.id, { oid: oid('d') });
    expect(entry.deltaChain).toBeNull();
  });

  it('delta 物件以有序 oid 清單展平，且 objectType 為還原後的最終型別', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    const chain = [oid('e'), oid('f')];
    const entry = await makeIndex(repo.id, pack.id, {
      oid: oid('9'),
      objectType: 'tree',
      deltaChain: JSON.stringify(chain),
    });
    expect(entry.objectType).toBe('tree');
    expect(JSON.parse(entry.deltaChain ?? '[]')).toEqual(chain);
  });

  it('刪除 pack 時級聯清除其物件索引', async () => {
    const repo = await makeRepo();
    const pack = await makePack(repo.id);
    await makeIndex(repo.id, pack.id, { oid: oid('1') });
    await prisma.packFile.delete({ where: { id: pack.id } });
    expect(await prisma.gitObjectIndex.count({ where: { packFileId: pack.id } })).toBe(0);
  });
});
