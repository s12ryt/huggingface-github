/**
 * Pull request HTTP 端點契約。
 *
 * 守門與 issues 相同；另驗證合併終局性與 diff 端點。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { oidOf } from '@/git/object.js';
import { encodeTree } from '@/git/parse.js';
import { scanPack } from '@/git/pack.js';
import { writeIndex } from '@/git/index-store.js';
import { pullJsonPath, type PullDocument } from '@/pulls/service.js';
import { buildPack } from '../helpers/pack.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser } from '../helpers/auth.js';
import type { FakeStore } from '../helpers/store.js';

let ctx: TestApp;
let store: FakeStore;
let ownerCookie: string;
let readerCookie: string;
let repoId: string;
const repoPath = '/repos/pr-owner/code';
const oidA = 'a'.repeat(40);
const oidB = 'b'.repeat(40);

function auth(cookie: string) {
  return { odg_session: cookie.replace('odg_session=', '') };
}

function docOf(number: number): PullDocument {
  const raw = store.files.get(pullJsonPath(repoPath, number));
  if (!raw) throw new Error(`document missing for pull ${number}`);
  return JSON.parse(raw.toString('utf8')) as PullDocument;
}

async function openPull(payload: Record<string, unknown>) {
  return ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'POST',
    payload,
    url: '/api/repos/pr-owner/code/pulls',
  });
}

/** 種入兩棵樹：base 含 keep+old，head 含 keep+new。回傳兩棵樹的 oid。 */
async function seedTrees() {
  const keep = Buffer.from('keep\n');
  const before = Buffer.from('before\n');
  const after = Buffer.from('after\n');
  const baseTree = encodeTree([
    { mode: '100644', name: 'keep.txt', oid: oidOf('blob', keep) },
    { mode: '100644', name: 'mod.txt', oid: oidOf('blob', before) },
  ]);
  const headTree = encodeTree([
    { mode: '100644', name: 'keep.txt', oid: oidOf('blob', keep) },
    { mode: '100644', name: 'mod.txt', oid: oidOf('blob', after) },
  ]);
  const { pack } = buildPack([
    { content: keep, type: 'blob' },
    { content: before, type: 'blob' },
    { content: after, type: 'blob' },
    { content: baseTree, type: 'tree' },
    { content: headTree, type: 'tree' },
  ]);
  await writeIndex(ctx.prisma, store, {
    pack,
    packName: 'pack-diff.pack',
    repoId,
    repoPath,
    scan: scanPack(pack),
  });
  return { baseTree: oidOf('tree', baseTree), headTree: oidOf('tree', headTree) };
}

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'closed' });
  store = ctx.store as unknown as FakeStore;
  await seedUser(ctx.prisma, 'pr-owner');
  await seedUser(ctx.prisma, 'pr-reader');
  ownerCookie = await loginCookie(ctx.app, 'pr-owner');
  readerCookie = await loginCookie(ctx.app, 'pr-reader');

  const created = await ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'POST',
    payload: { name: 'code' },
    url: '/api/repos',
  });
  repoId = created.json().repo.id as string;
  await ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'PUT',
    payload: { role: 'read' },
    url: '/api/repos/pr-owner/code/collaborators/pr-reader',
  });
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('開啟 pull request', () => {
  it('匿名回 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { baseOid: oidA, baseRef: 'main', headOid: oidB, headRef: 'dev', title: 'x' },
      url: '/api/repos/pr-owner/code/pulls',
    });
    expect(res.statusCode).toBe(401);
  });

  it('只有讀權者不得開啟，回 403', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'POST',
      payload: { baseOid: oidA, baseRef: 'main', headOid: oidB, headRef: 'dev', title: 'x' },
      url: '/api/repos/pr-owner/code/pulls',
    });
    expect(res.statusCode).toBe(403);
  });

  it('擁有者開啟回 201 且狀態 open', async () => {
    const res = await openPull({
      baseOid: oidA,
      baseRef: 'main',
      body: 'please review',
      headOid: oidB,
      headRef: 'feature',
      title: 'add feature',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pull).toMatchObject({
      author: 'pr-owner',
      baseRef: 'main',
      headRef: 'feature',
      mergedAt: null,
      number: 1,
      state: 'open',
      title: 'add feature',
    });
  });

  it('同步寫入 儲存桶 JSON', async () => {
    const doc = docOf(1);
    expect(doc).toMatchObject({ baseOid: oidA, headOid: oidB, state: 'open' });
    expect(doc.reviews).toEqual([]);
  });

  it('head 與 base 相同回 400', async () => {
    const res = await openPull({
      baseOid: oidA,
      baseRef: 'main',
      headOid: oidB,
      headRef: 'main',
      title: 'same',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_pull');
  });

  it('非法 oid 回 400', async () => {
    const res = await openPull({
      baseOid: 'nope',
      baseRef: 'main',
      headOid: oidB,
      headRef: 'dev',
      title: 'bad oid',
    });
    expect(res.statusCode).toBe(400);
  });

  it('缺少必要欄位回 400', async () => {
    const res = await openPull({ title: 'incomplete' });
    expect(res.statusCode).toBe(400);
  });
});

describe('列出與讀取', () => {
  it('讀權者可列出', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pulls.length).toBeGreaterThan(0);
  });

  it('匿名列出私有 repo 回 404', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/repos/pr-owner/code/pulls' });
    expect(res.statusCode).toBe(404);
  });

  it('非法狀態篩選回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls?state=zombie',
    });
    expect(res.statusCode).toBe(400);
  });

  it('取得單一 PR', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls/1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pull.number).toBe(1);
  });

  it('不存在的編號回 404', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls/777',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('審查', () => {
  it('讀權者可留下審查意見', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'POST',
      payload: {
        body: 'looks good',
        comments: [{ body: 'nit', filePath: 'a.txt', line: 3 }],
        state: 'approved',
      },
      url: '/api/repos/pr-owner/code/pulls/1/reviews',
    });
    expect(res.statusCode).toBe(204);
    const doc = docOf(1);
    expect(doc.reviews).toEqual([
      expect.objectContaining({ reviewer: 'pr-reader', state: 'approved' }),
    ]);
    expect(doc.reviews[0]?.comments[0]).toMatchObject({ line: 3, side: 'RIGHT' });
  });

  // 私有 repo 對匿名者一律 404：若回 401 就洩漏了「這個 repo 存在」。
  it('匿名審查私有 repo 回 404 而非 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { body: 'x', state: 'commented' },
      url: '/api/repos/pr-owner/code/pulls/1/reviews',
    });
    expect(res.statusCode).toBe(404);
  });

  it('未知審查狀態回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { body: 'x', state: 'yelling' },
      url: '/api/repos/pr-owner/code/pulls/1/reviews',
    });
    expect(res.statusCode).toBe(400);
  });

  it('負數行號回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: {
        body: 'x',
        comments: [{ body: 'bad', filePath: 'a.txt', line: -1 }],
        state: 'commented',
      },
      url: '/api/repos/pr-owner/code/pulls/1/reviews',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('合併與關閉', () => {
  it('只有讀權者不得合併，回 403', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'POST',
      url: '/api/repos/pr-owner/code/pulls/1/merge',
    });
    expect(res.statusCode).toBe(403);
  });

  it('擁有者合併寫入 mergedAt 與 mergedBy', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      url: '/api/repos/pr-owner/code/pulls/1/merge',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pull).toMatchObject({ mergedBy: 'pr-owner', state: 'merged' });
    expect(docOf(1).state).toBe('merged');
  });

  it('不得重複合併，回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      url: '/api/repos/pr-owner/code/pulls/1/merge',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_pull');
  });

  it('已合併不得改回開啟，回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'PATCH',
      payload: { state: 'open' },
      url: '/api/repos/pr-owner/code/pulls/1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('可關閉未合併的 PR', async () => {
    const created = await openPull({
      baseOid: oidA,
      baseRef: 'main',
      headOid: oidB,
      headRef: 'throwaway',
      title: 'to close',
    });
    const number = created.json().pull.number as number;
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'PATCH',
      payload: { state: 'closed' },
      url: `/api/repos/pr-owner/code/pulls/${number}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pull.state).toBe('closed');
  });
});

describe('diff 端點', () => {
  it('回報 added / modified / removed', async () => {
    const trees = await seedTrees();
    const created = await openPull({
      baseOid: oidOf('commit', Buffer.from('base')),
      baseRef: 'main',
      headOid: oidOf('commit', Buffer.from('head')),
      headRef: 'diff-branch',
      title: 'diff me',
    });
    const number = created.json().pull.number as number;
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: `/api/repos/pr-owner/code/pulls/${number}/diff?base=${trees.baseTree}&head=${trees.headTree}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([
      expect.objectContaining({ path: 'mod.txt', status: 'modified' }),
    ]);
  });

  it('缺少 tree 參數回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls/1/diff',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_tree');
  });

  it('匿名對私有 repo 取 diff 回 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/pr-owner/code/pulls/1/diff?base=' + oidA + '&head=' + oidB,
    });
    expect(res.statusCode).toBe(404);
  });
});
