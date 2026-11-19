/**
 * 物件讀取器（由 儲存桶 索引 + Range 還原物件）與 packfile 產出器。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb, type TestDb } from '../helpers/db.js';
import { buildPack, sha1Oid } from '../helpers/pack.js';
import { scanPack } from '@/git/pack.js';
import { writeIndex } from '@/git/index-store.js';
import { createObjectReader, ObjectReadError } from '@/git/reader.js';
import { buildPackFile, collectReachable } from '@/git/writer.js';
import { encodeTree } from '@/git/parse.js';
import { oidOf } from '@/git/object.js';

const REPO_PATH = '/repos/tester/demo';

interface Harness {
  prisma: PrismaClient;
  repoId: string;
  store: ReturnType<typeof fakeStore>;
}

function fakeStore() {
  const files = new Map<string, Buffer>();
  return {
    files,
    rangeCalls: 0,
    putBytes: async (path: string, data: Buffer) => {
      files.set(path, data);
    },
    putJson: async (path: string, value: unknown) => {
      files.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    },
    readAll: async (path: string) => files.get(path) ?? Buffer.alloc(0),
    readJson: async (path: string) => {
      const raw = files.get(path);
      return raw === undefined ? null : JSON.parse(raw.toString('utf8'));
    },
    readRanges: async function (
      this: { rangeCalls: number },
      path: string,
      ranges: readonly { start: number; end: number }[],
    ) {
      this.rangeCalls += 1;
      const file = files.get(path);
      if (file === undefined) throw new Error(`missing file ${path}`);
      return ranges.map((range) => file.subarray(range.start, range.end + 1));
    },
  };
}

let db: TestDb;
let harness: Harness;

beforeAll(async () => {
  db = createTestDb();
  const owner = await db.prisma.user.create({
    data: { passwordHash: '$argon2id$stub', username: 'reader-owner' },
    select: { id: true },
  });
  const repo = await db.prisma.repo.create({
    data: { name: 'demo', storagePath: REPO_PATH, ownerId: owner.id },
    select: { id: true },
  });
  harness = { prisma: db.prisma, repoId: repo.id, store: fakeStore() };
});

afterAll(async () => {
  await db.close();
});

async function seedPack(objects: Parameters<typeof buildPack>[0], packName: string) {
  const { pack } = buildPack(objects);
  const scan = scanPack(pack);
  await writeIndex(harness.prisma, harness.store, {
    pack,
    packName,
    repoId: harness.repoId,
    repoPath: REPO_PATH,
    scan,
  });
  return pack;
}

describe('createObjectReader', () => {
  it('讀回非 delta 物件的原始內容', async () => {
    const content = Buffer.from('plain blob\n');
    await seedPack([{ content, type: 'blob' }], 'p-plain.pack');
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const object = await reader.read(sha1Oid('blob', content));

    expect(object?.content.toString()).toBe('plain blob\n');
    expect(object?.type).toBe('blob');
  });

  it('未知 oid 回 null', async () => {
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    expect(await reader.read('f'.repeat(40))).toBeNull();
  });

  it('沿展平的 delta 鏈還原內容而不遞迴查表', async () => {
    const base = Buffer.from('shared prefix: AAAAAAAAAA\n');
    const mid = Buffer.from('shared prefix: BBBBBBBBBB\n');
    const top = Buffer.from('shared prefix: CCCCCCCCCC\n');
    const baseOid = sha1Oid('blob', base);
    const midOid = sha1Oid('blob', mid);

    await seedPack(
      [
        { content: base, type: 'blob' },
        { baseOid, content: mid, type: 'blob' },
        { baseOid: midOid, content: top, type: 'blob' },
      ],
      'p-delta.pack',
    );

    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const object = await reader.read(sha1Oid('blob', top));

    expect(object?.content.toString()).toBe('shared prefix: CCCCCCCCCC\n');
  });

  it('delta 物件只發出一次區間請求（鏈上全部位移一次取回）', async () => {
    const base = Buffer.from('range batch base 0000000000\n');
    const next = Buffer.from('range batch base 1111111111\n');
    const baseOid = sha1Oid('blob', base);

    await seedPack(
      [
        { content: base, type: 'blob' },
        { baseOid, content: next, type: 'blob' },
      ],
      'p-batch.pack',
    );

    const store = harness.store;
    store.rangeCalls = 0;
    const reader = createObjectReader(harness.prisma, store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    await reader.read(sha1Oid('blob', next));

    expect(store.rangeCalls).toBe(1);
  });

  it('readMany 對多個 oid 共用一次批次請求', async () => {
    const a = Buffer.from('many-a\n');
    const b = Buffer.from('many-b\n');
    await seedPack(
      [
        { content: a, type: 'blob' },
        { content: b, type: 'blob' },
      ],
      'p-many.pack',
    );

    const store = harness.store;
    store.rangeCalls = 0;
    const reader = createObjectReader(harness.prisma, store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const objects = await reader.readMany([sha1Oid('blob', a), sha1Oid('blob', b)]);

    expect(objects.map((item) => item.content.toString())).toEqual(['many-a\n', 'many-b\n']);
    expect(store.rangeCalls).toBe(1);
  });

  it('readMany 遇到缺失物件時拋錯而非悄悄少回', async () => {
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    await expect(reader.readMany(['e'.repeat(40)])).rejects.toThrow(ObjectReadError);
  });

  it('has 判斷物件是否存在而不取回內容', async () => {
    const content = Buffer.from('exists probe\n');
    await seedPack([{ content, type: 'blob' }], 'p-has.pack');
    const store = harness.store;
    store.rangeCalls = 0;
    const reader = createObjectReader(harness.prisma, store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    expect(await reader.has(sha1Oid('blob', content))).toBe(true);
    expect(await reader.has('0'.repeat(40))).toBe(false);
    expect(store.rangeCalls).toBe(0);
  });
});

describe('collectReachable', () => {
  it('從 commit 收集 commit、tree 與 blob', async () => {
    const blob = Buffer.from('reach blob\n');
    const blobOid = oidOf('blob', blob);
    const tree = encodeTree([{ mode: '100644', name: 'a.txt', oid: blobOid }]);
    const treeOid = oidOf('tree', tree);
    const commit = Buffer.from(`tree ${treeOid}\n\nreach\n`, 'utf8');
    const commitOid = oidOf('commit', commit);

    await seedPack(
      [
        { content: blob, type: 'blob' },
        { content: tree, type: 'tree' },
        { content: commit, type: 'commit' },
      ],
      'p-reach.pack',
    );

    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const reachable = await collectReachable(reader, [commitOid], []);

    expect([...reachable].sort()).toEqual([blobOid, commitOid, treeOid].sort());
  });

  it('排除 have 已持有的提交及其內容', async () => {
    const blob = Buffer.from('exclude blob\n');
    const blobOid = oidOf('blob', blob);
    const tree = encodeTree([{ mode: '100644', name: 'b.txt', oid: blobOid }]);
    const treeOid = oidOf('tree', tree);
    const first = Buffer.from(`tree ${treeOid}\n\nfirst\n`, 'utf8');
    const firstOid = oidOf('commit', first);
    const second = Buffer.from(`tree ${treeOid}\nparent ${firstOid}\n\nsecond\n`, 'utf8');
    const secondOid = oidOf('commit', second);

    await seedPack(
      [
        { content: blob, type: 'blob' },
        { content: tree, type: 'tree' },
        { content: first, type: 'commit' },
        { content: second, type: 'commit' },
      ],
      'p-exclude.pack',
    );

    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const reachable = await collectReachable(reader, [secondOid], [firstOid]);

    expect(reachable.has(secondOid)).toBe(true);
    expect(reachable.has(firstOid)).toBe(false);
    expect(reachable.has(treeOid)).toBe(false);
  });

  it('未知的 want 被忽略而不拋錯', async () => {
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    expect((await collectReachable(reader, ['d'.repeat(40)], [])).size).toBe(0);
  });
});

describe('buildPackFile', () => {
  it('產出可被 scanPack 解析的 packfile', async () => {
    const blob = Buffer.from('writer blob\n');
    await seedPack([{ content: blob, type: 'blob' }], 'p-writer.pack');
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const pack = await buildPackFile(reader, [oidOf('blob', blob)]);
    const scan = scanPack(pack);

    expect(scan.objectCount).toBe(1);
    expect(scan.entries[0]?.oid).toBe(oidOf('blob', blob));
  });

  it('空清單仍產出合法的零物件 packfile', async () => {
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const scan = scanPack(await buildPackFile(reader, []));

    expect(scan.objectCount).toBe(0);
    expect(scan.entries).toEqual([]);
  });

  it('多物件 packfile 的內容可完整往返', async () => {
    const one = Buffer.from('round-one\n');
    const two = Buffer.from('round-two\n');
    await seedPack(
      [
        { content: one, type: 'blob' },
        { content: two, type: 'blob' },
      ],
      'p-round.pack',
    );
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const pack = await buildPackFile(reader, [oidOf('blob', one), oidOf('blob', two)]);
    const scan = scanPack(pack);

    expect(scan.entries.map((entry) => entry.inflatedSize)).toEqual([one.length, two.length]);
  });

  it('packfile 以 sha1 trailer 結尾', async () => {
    const blob = Buffer.from('trailer\n');
    await seedPack([{ content: blob, type: 'blob' }], 'p-trailer.pack');
    const reader = createObjectReader(harness.prisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const pack = await buildPackFile(reader, [oidOf('blob', blob)]);
    const body = pack.subarray(0, pack.length - 20);
    const trailer = pack.subarray(pack.length - 20).toString('hex');

    expect(trailer).toBe(
      (await import('node:crypto')).createHash('sha1').update(body).digest('hex'),
    );
  });
});

describe('並行抓取', () => {
  it('多個 pack 的 readRanges 在彼此未完成前就已發出', async () => {
    const parA = Buffer.from('par-a\n');
    const parB = Buffer.from('par-b\n');
    await seedPack([{ content: parA, type: 'blob' }], 'p-par-a.pack');
    await seedPack([{ content: parB, type: 'blob' }], 'p-par-b.pack');

    let started = 0;
    const release: Array<() => void> = [];
    const io = {
      readRanges: async (path: string, ranges: readonly { start: number; end: number }[]) => {
        started += 1;
        await new Promise<void>((resolve) => release.push(resolve));
        return harness.store.readRanges(path, ranges);
      },
    };
    const reader = createObjectReader(harness.prisma, io, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const pending = reader.readMany([oidOf('blob', parA), oidOf('blob', parB)]);
    await vi.waitFor(() => {
      if (started < 2) throw new Error('second pack fetch not started');
    });
    release.forEach((resolve) => resolve());

    const objects = await pending;
    expect(objects.map((object) => object.content.toString())).toEqual(['par-a\n', 'par-b\n']);
  });

  it('readMany 以單批查詢解析全部物件，內容順序不變', async () => {
    const q1 = Buffer.from('query-one\n');
    const q2 = Buffer.from('query-two\n');
    await seedPack(
      [
        { content: q1, type: 'blob' },
        { content: q2, type: 'blob' },
      ],
      'p-query.pack',
    );

    const origUnique = harness.prisma.gitObjectIndex.findUnique.bind(harness.prisma.gitObjectIndex);
    const origMany = harness.prisma.gitObjectIndex.findMany.bind(harness.prisma.gitObjectIndex);
    let uniqueCalls = 0;
    let manyCalls = 0;
    const gatePrisma = {
      gitObjectIndex: {
        findUnique: async (args: unknown) => {
          uniqueCalls += 1;
          return origUnique(args as never);
        },
        findMany: async (args: unknown) => {
          manyCalls += 1;
          return origMany(args as never);
        },
      },
    } as unknown as PrismaClient;
    const reader = createObjectReader(gatePrisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    const objects = await reader.readMany([oidOf('blob', q1), oidOf('blob', q2)]);
    expect(objects.map((object) => object.content.toString())).toEqual(['query-one\n', 'query-two\n']);
    expect(manyCalls).toBe(1);
    expect(uniqueCalls).toBe(0);
  });
});

describe('批量查表', () => {
  it('delta 鏈的 base 由後續批次補查，缺失時依序報錯', async () => {
    const base = Buffer.from('chain-base\n');
    const { pack } = buildPack([{ content: base, type: 'blob' }]);
    const scan = scanPack(pack);
    const record = scan.entries[0];
    if (!record) throw new Error('seed pack has no entry');
    await writeIndex(harness.prisma, harness.store, {
      pack,
      packName: 'p-chain.pack',
      repoId: harness.repoId,
      repoPath: REPO_PATH,
      scan,
    });

    // 直接植入一筆帶鏈索引：目標指向不存在的 base，模擬鏈跨批解析。
    const missingOid = 'e'.repeat(40);
    const packFileRow = await harness.prisma.packFile.findFirstOrThrow({
      where: { repoId: harness.repoId, name: 'p-chain.pack' },
    });
    await harness.prisma.gitObjectIndex.create({
      data: {
        deltaChain: JSON.stringify([missingOid]),
        inflatedSize: record.inflatedSize,
        objectType: 'blob',
        oid: 'f'.repeat(40),
        packFileId: packFileRow.id,
        packOffset: record.packOffset,
        repoId: harness.repoId,
        storedSize: record.storedSize,
      },
    });

    const origMany = harness.prisma.gitObjectIndex.findMany.bind(harness.prisma.gitObjectIndex);
    let manyCalls = 0;
    const gatePrisma = {
      gitObjectIndex: {
        findMany: async (args: unknown) => {
          manyCalls += 1;
          return origMany(args as never);
        },
      },
    } as unknown as PrismaClient;
    const reader = createObjectReader(gatePrisma, harness.store, {
      repoId: harness.repoId,
      repoPath: REPO_PATH,
    });

    await expect(reader.readMany(['f'.repeat(40)])).rejects.toThrow(
      `delta base ${missingOid} is not indexed`,
    );
    expect(manyCalls).toBe(2);
  });
});
