/**
 * 索引雙存測試（E+1）：儲存桶 JSON 為權威、SQLite 為可重建快取。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildPack, sha1Oid } from '../helpers/pack.js';
import { scanPack } from '@/git/pack.js';
import {
  indexPath,
  loadIndex,
  lookupObject,
  packPath,
  rebuildCacheFromStore,
  writeIndex,
} from '@/git/index-store.js';

interface FakeStore {
  files: Map<string, Buffer>;
  readJson: (path: string) => Promise<unknown>;
  putJson: (path: string, value: unknown) => Promise<void>;
  putBytes: (path: string, data: Buffer) => Promise<void>;
  readAll: (path: string) => Promise<Buffer>;
}

function fakeStore(): FakeStore {
  const files = new Map<string, Buffer>();
  return {
    files,
    readJson: async (path) => {
      const raw = files.get(path);
      if (!raw) return null;
      try {
        return JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        return null;
      }
    },
    putJson: async (path, value) => {
      files.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    },
    putBytes: async (path, data) => {
      files.set(path, data);
    },
    readAll: async (path) => files.get(path) ?? Buffer.alloc(0),
  };
}

const blob = Buffer.from('index store payload', 'utf8');
const oid = sha1Oid('blob', blob);

let db: TestDb;
let prisma: PrismaClient;
let repoId = '';

beforeAll(async () => {
  db = createTestDb();
  prisma = db.prisma;
  const owner = await prisma.user.create({
    data: { username: 'index-owner', passwordHash: '$argon2id$stub' },
  });
  const repo = await prisma.repo.create({
    data: { ownerId: owner.id, name: 'idx', storagePath: '/repos/index-owner/idx' },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await db.close();
});

describe('路徑配置', () => {
  it('pack 與索引放在 repo 路徑下的 objects 目錄', () => {
    expect(packPath('/repos/a/b', 'pack-1.pack')).toBe('/repos/a/b/objects/pack-1.pack');
  });

  it('索引檔以 .idx.json 結尾以便人工檢視', () => {
    expect(indexPath('/repos/a/b', 'pack-1.pack')).toBe('/repos/a/b/objects/pack-1.idx.json');
  });
});

describe('寫入索引（雙存）', () => {
  it('同時寫入 儲存桶 權威副本與 SQLite 快取', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    const scan = scanPack(built.pack);

    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-w1.pack',
      pack: built.pack,
      scan,
    });

    expect(store.files.has('/repos/index-owner/idx/objects/pack-w1.pack')).toBe(true);
    expect(store.files.has('/repos/index-owner/idx/objects/pack-w1.idx.json')).toBe(true);
    const cached = await prisma.gitObjectIndex.count({ where: { repoId } });
    expect(cached).toBe(1);
  });

  it('記錄 pack 的位元組大小與物件數', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-w2.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });
    const row = await prisma.packFile.findFirst({ where: { repoId, name: 'pack-w2.pack' } });
    expect(row?.byteSize).toBe(built.pack.length);
    expect(row?.objectCount).toBe(1);
  });

  it('重複寫入同名 pack 為幂等覆寫而非報錯', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    const args = {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-w3.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    };
    await writeIndex(prisma, store, args);
    await writeIndex(prisma, store, args);
    const packs = await prisma.packFile.count({ where: { repoId, name: 'pack-w3.pack' } });
    expect(packs).toBe(1);
  });

  it('儲存桶 索引內容與 scanPack 結果一致', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    const scan = scanPack(built.pack);
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-w4.pack',
      pack: built.pack,
      scan,
    });
    const doc = await loadIndex(store, '/repos/index-owner/idx', 'pack-w4.pack');
    expect(doc?.entries).toEqual(scan.entries);
  });
});

describe('查詢物件位置', () => {
  it('從 SQLite 快取命中時回報 pack 名稱與三元組', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-q1.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });

    const found = await lookupObject(prisma, repoId, oid);
    expect(found?.packName).toBe('pack-q1.pack');
    expect(found?.packOffset).toBeGreaterThan(0);
    expect(found?.storedSize).toBeGreaterThan(0);
    expect(found?.inflatedSize).toBe(blob.length);
  });

  it('未知 oid 回 null', async () => {
    expect(await lookupObject(prisma, repoId, 'a'.repeat(40))).toBeNull();
  });

  it('回報展平後的 delta 鏈陣列', async () => {
    const found = await lookupObject(prisma, repoId, oid);
    expect(found?.deltaChain).toEqual([]);
  });
});

describe('從 儲存桶 重建 SQLite 快取', () => {
  it('快取被清空後可由權威副本完整重建', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-r1.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });

    await prisma.gitObjectIndex.deleteMany({ where: { repoId } });
    expect(await prisma.gitObjectIndex.count({ where: { repoId } })).toBe(0);

    const restored = await rebuildCacheFromStore(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packNames: ['pack-r1.pack'],
    });

    expect(restored).toBe(1);
    expect((await lookupObject(prisma, repoId, oid))?.packName).toBe('pack-r1.pack');
  });

  it('權威副本不存在時回報 0 且不拋錯', async () => {
    const restored = await rebuildCacheFromStore(prisma, fakeStore(), {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packNames: ['missing.pack'],
    });
    expect(restored).toBe(0);
  });

  it('重建為幂等，重複執行不產生重複列', async () => {
    const built = buildPack([{ type: 'blob', content: blob }]);
    const store = fakeStore();
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-r2.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });
    await rebuildCacheFromStore(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packNames: ['pack-r2.pack'],
    });
    await rebuildCacheFromStore(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packNames: ['pack-r2.pack'],
    });
    const rows = await prisma.gitObjectIndex.count({ where: { repoId, oid } });
    expect(rows).toBe(1);
  });

  it('loadIndex 對不存在的索引回 null', async () => {
    expect(await loadIndex(fakeStore(), '/repos/index-owner/idx', 'nope.pack')).toBeNull();
  });
});

describe('並行上傳', () => {
  it('pack 與索引上傳在彼此未完成前都已發出', async () => {
    const base = fakeStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const gated = {
      ...base,
      putBytes: async (path: string, data: Buffer) => {
        started += 1;
        await gate;
        return base.putBytes(path, data);
      },
      putJson: async (path: string, value: unknown) => {
        started += 1;
        await gate;
        return base.putJson(path, value);
      },
    };

    const built = buildPack([{ type: 'blob', content: blob }]);
    const pending = writeIndex(prisma, gated, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-par.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });
    await vi.waitFor(() => {
      if (started < 2) throw new Error(`started=${started}`);
    });
    release?.();
    await pending;
    expect(base.files.get('/repos/index-owner/idx/objects/pack-par.pack')?.length).toBe(
      built.pack.length,
    );
    expect(
      await lookupObject(prisma, repoId, oid),
    ).not.toBeNull();
  });
});

describe('重建免下載 pack', () => {
  it('byteSize 由索引推導，不讀取 pack 本體', async () => {
    const store = fakeStore();
    const built = buildPack([{ type: 'blob', content: blob }]);
    await writeIndex(prisma, store, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packName: 'pack-nd.pack',
      pack: built.pack,
      scan: scanPack(built.pack),
    });

    await prisma.gitObjectIndex.deleteMany({ where: { repoId } });
    await prisma.packFile.deleteMany({ where: { repoId } });

    let packReads = 0;
    const counting = {
      ...store,
      readAll: async (path: string) => {
        if (path.endsWith('.pack')) packReads += 1;
        return store.readAll(path);
      },
    };

    const restored = await rebuildCacheFromStore(prisma, counting, {
      repoId,
      repoPath: '/repos/index-owner/idx',
      packNames: ['pack-nd.pack'],
    });

    expect(restored).toBe(1);
    expect(packReads).toBe(0);
    const row = await prisma.packFile.findUnique({
      where: { repoId_name: { repoId, name: 'pack-nd.pack' } },
    });
    expect(row?.byteSize).toBe(built.pack.length);
    expect((await lookupObject(prisma, repoId, oid))?.packName).toBe('pack-nd.pack');
  });
});
