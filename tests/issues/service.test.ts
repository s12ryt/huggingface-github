/**
 * Issues 服務層測試 — 雙寫 SQLite + 儲存桶 JSON
 *
 * 1. 編號序列：issue 與 PR 共用同一序列，併發不重號
 * 2. 建立 issue：雙寫 DB 與 儲存桶 可讀 JSON
 * 3. 留言與狀態：開啟/關閉、留言雙寫
 * 4. 查詢與重建：列表、由 儲存桶 權威副本重建 DB
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import {
  addIssueComment,
  createIssue,
  issueJsonPath,
  listIssues,
  loadIssueDocument,
  nextItemNumber,
  rebuildIssuesFromStore,
  setIssueState,
} from '@/issues/service.js';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { createFakeStore, type FakeStore } from '../helpers/store.js';

let db: TestDb;
let store: FakeStore;
let repoId = '';
let authorId = '';
let otherId = '';
const repoPath = '/repos/issue-owner/tracker';

beforeAll(async () => {
  db = createTestDb();
  store = createFakeStore();
  const author = await db.prisma.user.create({
    data: { passwordHash: '$argon2id$stub', username: 'issue-owner' },
  });
  const other = await db.prisma.user.create({
    data: { passwordHash: '$argon2id$stub', username: 'issue-guest' },
  });
  authorId = author.id;
  otherId = other.id;
  const repo = await db.prisma.repo.create({
    data: { name: 'tracker', storagePath: repoPath, ownerId: author.id },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await db.close();
});

describe('編號序列', () => {
  it('第一個編號為 1', async () => {
    const fresh = createTestDb();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'seq-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'seq', storagePath: '/repos/seq-owner/seq', ownerId: user.id },
      });
      expect(await nextItemNumber(fresh.prisma, repo.id, 'issue')).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('issue 與 PR 共用同一序列而不重號', async () => {
    const fresh = createTestDb();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'seq-shared' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'shared', storagePath: '/repos/seq-shared/shared', ownerId: user.id },
      });
      const first = await nextItemNumber(fresh.prisma, repo.id, 'issue');
      const second = await nextItemNumber(fresh.prisma, repo.id, 'pull');
      const third = await nextItemNumber(fresh.prisma, repo.id, 'issue');
      expect([first, second, third]).toEqual([1, 2, 3]);
    } finally {
      await fresh.close();
    }
  });

  it('併發取號不產生重複', async () => {
    const fresh = createTestDb();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'seq-race' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'race', storagePath: '/repos/seq-race/race', ownerId: user.id },
      });
      const numbers = await Promise.all(
        Array.from({ length: 8 }, () => nextItemNumber(fresh.prisma, repo.id, 'issue')),
      );
      expect(new Set(numbers).size).toBe(8);
    } finally {
      await fresh.close();
    }
  });

  it('不同 repo 的編號各自獨立', async () => {
    const fresh = createTestDb();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'seq-multi' },
      });
      const a = await fresh.prisma.repo.create({
        data: { name: 'a', storagePath: '/repos/seq-multi/a', ownerId: user.id },
      });
      const b = await fresh.prisma.repo.create({
        data: { name: 'b', storagePath: '/repos/seq-multi/b', ownerId: user.id },
      });
      await nextItemNumber(fresh.prisma, a.id, 'issue');
      expect(await nextItemNumber(fresh.prisma, b.id, 'issue')).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});

describe('建立 issue 與雙寫', () => {
  it('回傳編號遞增的 issue', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      body: '重現步驟如下',
      repoId,
      repoPath,
      title: '登入後跳轉錯誤',
    });
    expect(issue.number).toBeGreaterThanOrEqual(1);
    expect(issue.title).toBe('登入後跳轉錯誤');
    expect(issue.state).toBe('open');
  });

  it('寫入 儲存桶 的 JSON 路徑帶編號', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '路徑檢查',
    });
    const path = issueJsonPath(repoPath, issue.number);
    expect(path).toBe(`${repoPath}/issues/${issue.number}.json`);
    expect(store.files.has(path)).toBe(true);
  });

  it('儲存桶 JSON 為人類可讀的縮排格式', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '可讀性',
    });
    const raw = store.files.get(issueJsonPath(repoPath, issue.number))?.toString('utf8') ?? '';
    expect(raw).toContain('\n  ');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('JSON 權威副本含標題、狀態、作者與留言陣列', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      body: '內文',
      repoId,
      repoPath,
      title: '欄位檢查',
    });
    const doc = await loadIssueDocument(store, repoPath, issue.number);
    expect(doc).toMatchObject({
      author: 'issue-owner',
      body: '內文',
      comments: [],
      number: issue.number,
      state: 'open',
      title: '欄位檢查',
    });
  });

  it('SQLite 與 JSON 的編號一致', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '一致性',
    });
    const row = await db.prisma.issue.findUnique({
      where: { repoId_number: { number: issue.number, repoId } },
    });
    expect(row?.storagePath).toBe(issueJsonPath(repoPath, issue.number));
  });

  it('未提供內文時以空字串保存', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '無內文',
    });
    expect(issue.body).toBe('');
  });

  it('拒絕空白標題', async () => {
    await expect(
      createIssue(db.prisma, store, { authorId, repoId, repoPath, title: '   ' }),
    ).rejects.toThrow(/title/i);
  });

  it('標題前後空白被修掉', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '  有空白  ',
    });
    expect(issue.title).toBe('有空白');
  });
});

describe('留言與狀態', () => {
  it('新增留言後 JSON 權威副本同步', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '留言測試',
    });
    await addIssueComment(db.prisma, store, {
      authorId: otherId,
      body: '我也遇到了',
      issueId: issue.id,
      repoPath,
    });
    const doc = await loadIssueDocument(store, repoPath, issue.number);
    expect(doc?.comments).toHaveLength(1);
    expect(doc?.comments[0]).toMatchObject({ author: 'issue-guest', body: '我也遇到了' });
  });

  it('留言同時寫入 SQLite', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '留言入庫',
    });
    await addIssueComment(db.prisma, store, {
      authorId,
      body: '補充資訊',
      issueId: issue.id,
      repoPath,
    });
    const count = await db.prisma.issueComment.count({ where: { issueId: issue.id } });
    expect(count).toBe(1);
  });

  it('留言保序', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '留言保序',
    });
    for (const body of ['一', '二', '三']) {
      await addIssueComment(db.prisma, store, { authorId, body, issueId: issue.id, repoPath });
    }
    const doc = await loadIssueDocument(store, repoPath, issue.number);
    expect(doc?.comments.map((c) => c.body)).toEqual(['一', '二', '三']);
  });

  it('拒絕空白留言', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '空留言',
    });
    await expect(
      addIssueComment(db.prisma, store, { authorId, body: '  ', issueId: issue.id, repoPath }),
    ).rejects.toThrow(/body/i);
  });

  it('關閉 issue 寫入 closedAt 並同步 JSON', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '待關閉',
    });
    const closed = await setIssueState(db.prisma, store, {
      issueId: issue.id,
      repoPath,
      state: 'closed',
    });
    expect(closed.state).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    const doc = await loadIssueDocument(store, repoPath, issue.number);
    expect(doc?.state).toBe('closed');
  });

  it('重新開啟 issue 清除 closedAt', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '重開',
    });
    await setIssueState(db.prisma, store, { issueId: issue.id, repoPath, state: 'closed' });
    const reopened = await setIssueState(db.prisma, store, {
      issueId: issue.id,
      repoPath,
      state: 'open',
    });
    expect(reopened.state).toBe('open');
    expect(reopened.closedAt).toBeNull();
  });

  it('拒絕未知狀態', async () => {
    const issue = await createIssue(db.prisma, store, {
      authorId,
      repoId,
      repoPath,
      title: '狀態守門',
    });
    await expect(
      setIssueState(db.prisma, store, {
        issueId: issue.id,
        repoPath,
        state: 'archived' as 'open',
      }),
    ).rejects.toThrow(/state/i);
  });

  it('對不存在的 issue 留言拋錯', async () => {
    await expect(
      addIssueComment(db.prisma, store, {
        authorId,
        body: '幽靈留言',
        issueId: 'missing-id',
        repoPath,
      }),
    ).rejects.toThrow();
  });
});

describe('查詢與重建', () => {
  it('列表依編號遞減', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'list-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'list', storagePath: '/repos/list-owner/list', ownerId: user.id },
      });
      for (const title of ['第一', '第二', '第三']) {
        await createIssue(fresh.prisma, freshStore, {
          authorId: user.id,
          repoId: repo.id,
          repoPath: '/repos/list-owner/list',
          title,
        });
      }
      const list = await listIssues(fresh.prisma, repo.id);
      expect(list.map((i) => i.number)).toEqual([3, 2, 1]);
    } finally {
      await fresh.close();
    }
  });

  it('可依狀態篩選', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'filter-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'filter', storagePath: '/repos/filter-owner/filter', ownerId: user.id },
      });
      const path = '/repos/filter-owner/filter';
      const first = await createIssue(fresh.prisma, freshStore, {
        authorId: user.id,
        repoId: repo.id,
        repoPath: path,
        title: '開著',
      });
      const second = await createIssue(fresh.prisma, freshStore, {
        authorId: user.id,
        repoId: repo.id,
        repoPath: path,
        title: '關掉',
      });
      await setIssueState(fresh.prisma, freshStore, {
        issueId: second.id,
        repoPath: path,
        state: 'closed',
      });
      const open = await listIssues(fresh.prisma, repo.id, 'open');
      expect(open.map((i) => i.number)).toEqual([first.number]);
    } finally {
      await fresh.close();
    }
  });

  it('SQLite 清空後可由 儲存桶 權威副本完整重建', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'rebuild-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'rebuild', storagePath: '/repos/rebuild-owner/rebuild', ownerId: user.id },
      });
      const path = '/repos/rebuild-owner/rebuild';
      const issue = await createIssue(fresh.prisma, freshStore, {
        authorId: user.id,
        body: '原始內文',
        repoId: repo.id,
        repoPath: path,
        title: '要被重建的',
      });
      await addIssueComment(fresh.prisma, freshStore, {
        authorId: user.id,
        body: '原始留言',
        issueId: issue.id,
        repoPath: path,
      });

      await fresh.prisma.issue.deleteMany({ where: { repoId: repo.id } });
      expect(await fresh.prisma.issue.count({ where: { repoId: repo.id } })).toBe(0);

      const restored = await rebuildIssuesFromStore(fresh.prisma, freshStore, {
        numbers: [issue.number],
        repoId: repo.id,
        repoPath: path,
      });
      expect(restored).toBe(1);

      const row = await fresh.prisma.issue.findUnique({
        where: { repoId_number: { number: issue.number, repoId: repo.id } },
        include: { comments: true },
      });
      expect(row?.title).toBe('要被重建的');
      expect(row?.body).toBe('原始內文');
      expect(row?.comments).toHaveLength(1);
      expect(row?.comments[0]?.body).toBe('原始留言');
    } finally {
      await fresh.close();
    }
  });

  it('重建為幂等操作', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'idem-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'idem', storagePath: '/repos/idem-owner/idem', ownerId: user.id },
      });
      const path = '/repos/idem-owner/idem';
      const issue = await createIssue(fresh.prisma, freshStore, {
        authorId: user.id,
        repoId: repo.id,
        repoPath: path,
        title: '幂等',
      });
      await rebuildIssuesFromStore(fresh.prisma, freshStore, {
        numbers: [issue.number],
        repoId: repo.id,
        repoPath: path,
      });
      await rebuildIssuesFromStore(fresh.prisma, freshStore, {
        numbers: [issue.number],
        repoId: repo.id,
        repoPath: path,
      });
      expect(await fresh.prisma.issue.count({ where: { repoId: repo.id } })).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('權威副本不存在時回 0 而不拋錯', async () => {
    const restored = await rebuildIssuesFromStore(db.prisma, store, {
      numbers: [9999],
      repoId,
      repoPath,
    });
    expect(restored).toBe(0);
  });

  it('同作者的多次解析只查詢一次使用者', async () => {
    const fresh = createTestDb();
    const freshStore = createFakeStore();
    try {
      const user = await fresh.prisma.user.create({
        data: { passwordHash: '$argon2id$stub', username: 'memo-owner' },
      });
      const repo = await fresh.prisma.repo.create({
        data: { name: 'memo', storagePath: '/repos/memo-owner/memo', ownerId: user.id },
      });
      const path = '/repos/memo-owner/memo';
      const issue = await createIssue(fresh.prisma, freshStore, {
        authorId: user.id,
        repoId: repo.id,
        repoPath: path,
        title: '作者快取',
      });
      await addIssueComment(fresh.prisma, freshStore, {
        authorId: user.id,
        body: '第一則',
        issueId: issue.id,
        repoPath: path,
      });
      await addIssueComment(fresh.prisma, freshStore, {
        authorId: user.id,
        body: '第二則',
        issueId: issue.id,
        repoPath: path,
      });
      await fresh.prisma.issue.deleteMany({ where: { repoId: repo.id } });

      // spy 測試：顯式 passthrough，測後還原放 finally（Prisma method 還原不可靠，故置於最後並立即關庫）。
      const find = fresh.prisma.user.findUnique.bind(fresh.prisma.user);
      let calls = 0;
      const spy = vi.spyOn(fresh.prisma.user, 'findUnique').mockImplementation(
        (async (...args: Parameters<typeof find>) => {
          calls += 1;
          return find(...args);
        }) as unknown as typeof fresh.prisma.user.findUnique,
      );
      const restored = await rebuildIssuesFromStore(fresh.prisma, freshStore, {
        numbers: [issue.number],
        repoId: repo.id,
        repoPath: path,
      });
      spy.mockRestore();
      expect(restored).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});
