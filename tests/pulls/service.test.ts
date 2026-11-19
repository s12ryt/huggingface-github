/**
 * Pull Request 服務層測試 — 雙寫、共用編號、diff review
 *
 * 1. 建立 PR：與 issue 共用編號序列、雙寫 儲存桶 JSON
 * 2. 審查：review 與行級留言
 * 3. 合併與關閉：mergedAt / mergedById
 * 4. diff：以 git 物件層算出變更檔案清單
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import { buildPackFile } from '@/git/writer.js';
import { createObjectReader } from '@/git/reader.js';
import { scanPack } from '@/git/pack.js';
import { writeIndex } from '@/git/index-store.js';
import { encodeTree } from '@/git/parse.js';
import { oidOf } from '@/git/object.js';
import {
  addReview,
  createPullRequest,
  diffTrees,
  listPullRequests,
  loadPullDocument,
  mergePullRequest,
  pullJsonPath,
  setPullState,
} from '@/pulls/service.js';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { createFakeStore, type FakeStore } from '../helpers/store.js';
import { buildPack } from '../helpers/pack.js';

let db: TestDb;
let store: FakeStore;
let repoId = '';
let authorId = '';
let reviewerId = '';
const repoPath = '/repos/pull-owner/pulls';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

beforeAll(async () => {
  db = createTestDb();
  store = createFakeStore();
  const author = await db.prisma.user.create({
    data: { passwordHash: '$argon2id$stub', username: 'pull-owner' },
  });
  const reviewer = await db.prisma.user.create({
    data: { passwordHash: '$argon2id$stub', username: 'pull-reviewer' },
  });
  authorId = author.id;
  reviewerId = reviewer.id;
  const repo = await db.prisma.repo.create({
    data: { name: 'pulls', storagePath: repoPath, ownerId: author.id },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await db.close();
});

function basePull(title: string) {
  return {
    authorId,
    baseOid: OID_B,
    baseRef: 'refs/heads/main',
    headOid: OID_A,
    headRef: 'refs/heads/feature',
    repoId,
    repoPath,
    title,
  };
}

describe('建立 pull request', () => {
  it('回傳編號與預設開啟狀態', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('加入搜尋功能'));
    expect(pull.number).toBeGreaterThanOrEqual(1);
    expect(pull.state).toBe('open');
    expect(pull.mergedAt).toBeNull();
  });

  it('與 issue 共用同一編號序列', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'shared-seq' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'seq', storagePath: '/repos/shared-seq/seq', ownerId: user.id },
      });
      await fresh.prisma.repoItemNumber.create({
        data: { kind: 'issue', number: 1, repoId: repo.id },
      });
      const pull = await createPullRequest(fresh.prisma, freshStore, {
        authorId: user.id,
        baseOid: OID_B,
        baseRef: 'refs/heads/main',
        headOid: OID_A,
        headRef: 'refs/heads/x',
        repoId: repo.id,
        repoPath: '/repos/shared-seq/seq',
        title: '接在 issue 之後',
      });
      expect(pull.number).toBe(2);
    } finally {
      await fresh.close();
    }
  });

  it('JSON 路徑帶編號', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('路徑'));
    const path = pullJsonPath(repoPath, pull.number);
    expect(path).toBe(`${repoPath}/pulls/${pull.number}.json`);
    expect(store.files.has(path)).toBe(true);
  });

  it('JSON 權威副本含分支與 oid', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('欄位'));
    const doc = await loadPullDocument(store, repoPath, pull.number);
    expect(doc).toMatchObject({
      author: 'pull-owner',
      baseOid: OID_B,
      baseRef: 'refs/heads/main',
      headOid: OID_A,
      headRef: 'refs/heads/feature',
      reviews: [],
      state: 'open',
    });
  });

  it('JSON 為可讀縮排格式', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('可讀'));
    const raw = store.files.get(pullJsonPath(repoPath, pull.number))?.toString('utf8') ?? '';
    expect(raw).toContain('\n  ');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('拒絕空白標題', async () => {
    await expect(createPullRequest(db.prisma, store, basePull('   '))).rejects.toThrow(/title/i);
  });

  it('拒絕 head 與 base 相同的分支', async () => {
    await expect(
      createPullRequest(db.prisma, store, {
        ...basePull('同分支'),
        headRef: 'refs/heads/main',
      }),
    ).rejects.toThrow(/branch/i);
  });

  it('拒絕非法 oid', async () => {
    await expect(
      createPullRequest(db.prisma, store, { ...basePull('壞 oid'), headOid: 'zz' }),
    ).rejects.toThrow(/oid/i);
  });
});

describe('審查與行級留言', () => {
  it('新增 review 後 JSON 同步', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('待審查'));
    await addReview(db.prisma, store, {
      body: '整體看起來不錯',
      comments: [],
      pullRequestId: pull.id,
      repoPath,
      reviewerId,
      state: 'approved',
    });
    const doc = await loadPullDocument(store, repoPath, pull.number);
    expect(doc?.reviews).toHaveLength(1);
    expect(doc?.reviews[0]).toMatchObject({ reviewer: 'pull-reviewer', state: 'approved' });
  });

  it('行級留言保存檔案與行號', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('行級留言'));
    await addReview(db.prisma, store, {
      body: '請改這裡',
      comments: [{ body: '這個變數沒用到', filePath: 'src/a.ts', line: 12, side: 'RIGHT' }],
      pullRequestId: pull.id,
      repoPath,
      reviewerId,
      state: 'changes_requested',
    });
    const doc = await loadPullDocument(store, repoPath, pull.number);
    expect(doc?.reviews[0]?.comments[0]).toMatchObject({
      body: '這個變數沒用到',
      filePath: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
    });
  });

  it('行級留言預設落在新版本一側', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('預設側'));
    await addReview(db.prisma, store, {
      body: '',
      comments: [{ body: '補註解', filePath: 'src/b.ts', line: 3 }],
      pullRequestId: pull.id,
      repoPath,
      reviewerId,
      state: 'commented',
    });
    const row = await db.prisma.pullRequestReviewComment.findFirst({
      where: { review: { pullRequestId: pull.id } },
    });
    expect(row?.side).toBe('RIGHT');
  });

  it('拒絕未知審查狀態', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('狀態守門'));
    await expect(
      addReview(db.prisma, store, {
        body: '',
        comments: [],
        pullRequestId: pull.id,
        repoPath,
        reviewerId,
        state: 'rejected' as 'approved',
      }),
    ).rejects.toThrow(/state/i);
  });

  it('拒絕負數行號', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('行號守門'));
    await expect(
      addReview(db.prisma, store, {
        body: '',
        comments: [{ body: 'x', filePath: 'a.ts', line: -1 }],
        pullRequestId: pull.id,
        repoPath,
        reviewerId,
        state: 'commented',
      }),
    ).rejects.toThrow(/line/i);
  });

  it('多筆 review 保序', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('多審查'));
    for (const body of ['第一輪', '第二輪']) {
      await addReview(db.prisma, store, {
        body,
        comments: [],
        pullRequestId: pull.id,
        repoPath,
        reviewerId,
        state: 'commented',
      });
    }
    const doc = await loadPullDocument(store, repoPath, pull.number);
    expect(doc?.reviews.map((r) => r.body)).toEqual(['第一輪', '第二輪']);
  });
});

describe('合併與關閉', () => {
  it('合併寫入 mergedAt 與合併者', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('可合併'));
    const merged = await mergePullRequest(db.prisma, store, {
      mergedById: reviewerId,
      pullRequestId: pull.id,
      repoPath,
    });
    expect(merged.state).toBe('merged');
    expect(merged.mergedAt).not.toBeNull();
    expect(merged.mergedBy).toBe('pull-reviewer');
  });

  it('合併後的 JSON 標記 merged', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('合併同步'));
    await mergePullRequest(db.prisma, store, {
      mergedById: reviewerId,
      pullRequestId: pull.id,
      repoPath,
    });
    const doc = await loadPullDocument(store, repoPath, pull.number);
    expect(doc?.state).toBe('merged');
    expect(doc?.mergedBy).toBe('pull-reviewer');
  });

  it('已合併的 PR 不得重複合併', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('重複合併'));
    await mergePullRequest(db.prisma, store, {
      mergedById: reviewerId,
      pullRequestId: pull.id,
      repoPath,
    });
    await expect(
      mergePullRequest(db.prisma, store, {
        mergedById: reviewerId,
        pullRequestId: pull.id,
        repoPath,
      }),
    ).rejects.toThrow(/merged/i);
  });

  it('可關閉未合併的 PR', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('關閉'));
    const closed = await setPullState(db.prisma, store, {
      pullRequestId: pull.id,
      repoPath,
      state: 'closed',
    });
    expect(closed.state).toBe('closed');
    expect(closed.mergedAt).toBeNull();
  });

  it('已合併的 PR 不得被改回開啟', async () => {
    const pull = await createPullRequest(db.prisma, store, basePull('不可重開'));
    await mergePullRequest(db.prisma, store, {
      mergedById: reviewerId,
      pullRequestId: pull.id,
      repoPath,
    });
    await expect(
      setPullState(db.prisma, store, {
        pullRequestId: pull.id,
        repoPath,
        state: 'open',
      }),
    ).rejects.toThrow(/merged/i);
  });

  it('列表依編號遞減並可依狀態篩選', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'pull-list' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'list', storagePath: '/repos/pull-list/list', ownerId: user.id },
      });
      const path = '/repos/pull-list/list';
      const make = (title: string) =>
        createPullRequest(fresh.prisma, freshStore, {
          authorId: user.id,
          baseOid: OID_B,
          baseRef: 'refs/heads/main',
          headOid: OID_A,
          headRef: `refs/heads/${title}`,
          repoId: repo.id,
          repoPath: path,
          title,
        });
      const first = await make('one');
      const second = await make('two');
      await setPullState(fresh.prisma, freshStore, {
        pullRequestId: second.id,
        repoPath: path,
        state: 'closed',
      });
      const all = await listPullRequests(fresh.prisma, repo.id);
      expect(all.map((p) => p.number)).toEqual([second.number, first.number]);
      const open = await listPullRequests(fresh.prisma, repo.id, 'open');
      expect(open.map((p) => p.number)).toEqual([first.number]);
    } finally {
      await fresh.close();
    }
  });
});

describe('diff 計算', () => {
  async function seedTrees() {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    const user = await fresh.prisma.user.create({
      data: { passwordHash: '$argon2id$stub', username: 'diff-owner' },
    });
    const repo = await fresh.prisma.repo.create({
      data: { name: 'diff', storagePath: '/repos/diff-owner/diff', ownerId: user.id },
    });
    const path = '/repos/diff-owner/diff';

    const keep = Buffer.from('unchanged\n');
    const before = Buffer.from('old content\n');
    const after = Buffer.from('new content\n');
    const removed = Buffer.from('bye\n');
    const added = Buffer.from('hello\n');

    const baseTree = encodeTree([
      { mode: '100644', name: 'keep.txt', oid: oidOf('blob', keep) },
      { mode: '100644', name: 'mod.txt', oid: oidOf('blob', before) },
      { mode: '100644', name: 'gone.txt', oid: oidOf('blob', removed) },
    ]);
    const headTree = encodeTree([
      { mode: '100644', name: 'keep.txt', oid: oidOf('blob', keep) },
      { mode: '100644', name: 'mod.txt', oid: oidOf('blob', after) },
      { mode: '100644', name: 'new.txt', oid: oidOf('blob', added) },
    ]);

    const { pack } = buildPack([
      { content: keep, type: 'blob' },
      { content: before, type: 'blob' },
      { content: after, type: 'blob' },
      { content: removed, type: 'blob' },
      { content: added, type: 'blob' },
      { content: baseTree, type: 'tree' },
      { content: headTree, type: 'tree' },
    ]);
    const scan = scanPack(pack);
    await writeIndex(fresh.prisma, freshStore, {
      pack,
      packName: 'pack-diff.pack',
      repoId: repo.id,
      repoPath: path,
      scan,
    });
    const reader = createObjectReader(fresh.prisma, freshStore, {
      repoId: repo.id,
      repoPath: path,
    });
    return {
      baseTree: oidOf('tree', baseTree),
      close: () => fresh.close(),
      headTree: oidOf('tree', headTree),
      reader,
    };
  }

  it('辨認新增、修改與刪除的檔案', async () => {
    const ctx = await seedTrees();
    try {
      const diff = await diffTrees(ctx.reader, ctx.baseTree, ctx.headTree);
      const byPath = new Map(diff.map((entry) => [entry.path, entry.status]));
      expect(byPath.get('new.txt')).toBe('added');
      expect(byPath.get('mod.txt')).toBe('modified');
      expect(byPath.get('gone.txt')).toBe('removed');
    } finally {
      await ctx.close();
    }
  });

  it('未變更的檔案不出現在 diff', async () => {
    const ctx = await seedTrees();
    try {
      const diff = await diffTrees(ctx.reader, ctx.baseTree, ctx.headTree);
      expect(diff.some((entry) => entry.path === 'keep.txt')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('diff 依路徑排序', async () => {
    const ctx = await seedTrees();
    try {
      const diff = await diffTrees(ctx.reader, ctx.baseTree, ctx.headTree);
      const paths = diff.map((entry) => entry.path);
      expect(paths).toEqual([...paths].sort());
    } finally {
      await ctx.close();
    }
  });

  it('相同的樹得到空 diff', async () => {
    const ctx = await seedTrees();
    try {
      const diff = await diffTrees(ctx.reader, ctx.headTree, ctx.headTree);
      expect(diff).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('diff 帶出新舊 oid 供後續取內容', async () => {
    const ctx = await seedTrees();
    try {
      const diff = await diffTrees(ctx.reader, ctx.baseTree, ctx.headTree);
      const modified = diff.find((entry) => entry.path === 'mod.txt');
      expect(modified?.oldOid).toMatch(/^[0-9a-f]{40}$/);
      expect(modified?.newOid).toMatch(/^[0-9a-f]{40}$/);
      expect(modified?.oldOid).not.toBe(modified?.newOid);
      const added = diff.find((entry) => entry.path === 'new.txt');
      expect(added?.oldOid).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('空的 base 樹視為全部新增', async () => {
    const ctx = await seedTrees();
    try {
      const empty = oidOf('tree', encodeTree([]));
      const diff = await diffTrees(ctx.reader, empty, ctx.headTree);
      expect(diff.every((entry) => entry.status === 'added')).toBe(true);
      expect(diff).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });
});

describe('buildPackFile 與 diff 的互通', () => {
  it('buildPackFile 產出的 pack 可供 diff 讀取', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'interop' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'interop', storagePath: '/repos/interop/interop', ownerId: user.id },
      });
      const path = '/repos/interop/interop';
      const blob = Buffer.from('content\n');
      const tree = encodeTree([{ mode: '100644', name: 'f.txt', oid: oidOf('blob', blob) }]);
      const { pack } = buildPack([
        { content: blob, type: 'blob' },
        { content: tree, type: 'tree' },
      ]);
      await writeIndex(fresh.prisma, freshStore, {
        pack,
        packName: 'pack-interop.pack',
        repoId: repo.id,
        repoPath: path,
        scan: scanPack(pack),
      });
      const reader = createObjectReader(fresh.prisma, freshStore, {
        repoId: repo.id,
        repoPath: path,
      });
      const rebuilt = await buildPackFile(reader, [oidOf('tree', tree), oidOf('blob', blob)]);
      expect(scanPack(rebuilt).objectCount).toBe(2);
    } finally {
      await fresh.close();
    }
  });
});

describe('diff 並行讀取', () => {
  it('同層子樹的讀取在彼此未完成前都已發出', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'par-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'par', storagePath: '/repos/par-owner/par', ownerId: user.id },
      });
      const path = '/repos/par-owner/par';

      const a1 = Buffer.from('a1\n');
      const a2 = Buffer.from('a2\n');
      const b1 = Buffer.from('b1\n');
      const b2 = Buffer.from('b2\n');
      const dirA = encodeTree([{ mode: '100644', name: 'one.txt', oid: oidOf('blob', a1) }]);
      const dirB = encodeTree([{ mode: '100644', name: 'two.txt', oid: oidOf('blob', b1) }]);
      const dirAPrime = encodeTree([{ mode: '100644', name: 'one.txt', oid: oidOf('blob', a2) }]);
      const dirBPrime = encodeTree([{ mode: '100644', name: 'two.txt', oid: oidOf('blob', b2) }]);
      const baseRoot = encodeTree([
        { mode: '40000', name: 'alpha', oid: oidOf('tree', dirA) },
        { mode: '40000', name: 'beta', oid: oidOf('tree', dirB) },
      ]);
      const headRoot = encodeTree([
        { mode: '40000', name: 'alpha', oid: oidOf('tree', dirAPrime) },
        { mode: '40000', name: 'beta', oid: oidOf('tree', dirBPrime) },
      ]);
      const baseRootOid = oidOf('tree', baseRoot);
      const headRootOid = oidOf('tree', headRoot);

      const { pack } = buildPack([
        { content: a1, type: 'blob' },
        { content: a2, type: 'blob' },
        { content: b1, type: 'blob' },
        { content: b2, type: 'blob' },
        { content: dirA, type: 'tree' },
        { content: dirB, type: 'tree' },
        { content: dirAPrime, type: 'tree' },
        { content: dirBPrime, type: 'tree' },
        { content: baseRoot, type: 'tree' },
        { content: headRoot, type: 'tree' },
      ]);
      await writeIndex(fresh.prisma, freshStore, {
        pack,
        packName: 'pack-par.pack',
        repoId: repo.id,
        repoPath: path,
        scan: scanPack(pack),
      });
      const reader = createObjectReader(fresh.prisma, freshStore, {
        repoId: repo.id,
        repoPath: path,
      });

      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending = 0;
      const gated = {
        ...reader,
        read: async (oid: string) => {
          if (oid !== baseRootOid && oid !== headRootOid) {
            pending += 1;
            await gate;
          }
          return reader.read(oid);
        },
      };

      const diffPromise = diffTrees(gated, baseRootOid, headRootOid);
      await vi.waitFor(() => {
        if (pending < 2) throw new Error(`pending=${pending}`);
      });
      release?.();
      const diff = await diffPromise;
      expect(diff.map((entry) => entry.path).sort()).toEqual(['alpha/one.txt', 'beta/two.txt']);
      expect(diff.every((entry) => entry.status === 'modified')).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});
