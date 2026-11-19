/**
 * Issues HTTP 端點契約。
 *
 * 守門不變量：無讀取權一律 404（匿名則 401），讀權者不得寫入（403）。
 * 雙寫不變量：每次寫入後 儲存桶 JSON 必須與 SQLite 同步。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import { issueJsonPath, type IssueDocument } from '@/issues/service.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser } from '../helpers/auth.js';
import type { FakeStore } from '../helpers/store.js';

let ctx: TestApp;
let store: FakeStore;
let ownerCookie: string;
let readerCookie: string;
let strangerCookie: string;
const repoPath = '/repos/iss-owner/notes';

function auth(cookie: string) {
  return { odg_session: cookie.replace('odg_session=', '') };
}

function docOf(number: number): IssueDocument {
  const raw = store.files.get(issueJsonPath(repoPath, number));
  if (!raw) throw new Error(`document missing for issue ${number}`);
  return JSON.parse(raw.toString('utf8')) as IssueDocument;
}

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'closed' });
  store = ctx.store as unknown as FakeStore;
  await seedUser(ctx.prisma, 'iss-owner');
  await seedUser(ctx.prisma, 'iss-reader');
  await seedUser(ctx.prisma, 'iss-stranger');
  ownerCookie = await loginCookie(ctx.app, 'iss-owner');
  readerCookie = await loginCookie(ctx.app, 'iss-reader');
  strangerCookie = await loginCookie(ctx.app, 'iss-stranger');

  await ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'POST',
    payload: { name: 'notes' },
    url: '/api/repos',
  });
  await ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'PUT',
    payload: { role: 'read' },
    url: '/api/repos/iss-owner/notes/collaborators/iss-reader',
  });
  await ctx.app.inject({
    cookies: auth(ownerCookie),
    method: 'POST',
    payload: { name: 'open-notes', visibility: 'public' },
    url: '/api/repos',
  });
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('建立 issue', () => {
  it('匿名建立回 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { title: 'anon' },
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(401);
  });

  it('無任何權限者看不到 repo，回 404', async () => {
    const res = await ctx.app.inject({
      cookies: auth(strangerCookie),
      method: 'POST',
      payload: { title: 'intruder' },
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(404);
  });

  it('只有讀權的協作者不得建立，回 403', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'POST',
      payload: { title: 'read only' },
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(403);
  });

  it('擁有者建立回 201，編號自 1 起算且狀態為 open', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { body: 'first body', title: 'first issue' },
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().issue).toMatchObject({
      author: 'iss-owner',
      number: 1,
      state: 'open',
      title: 'first issue',
    });
  });

  it('同步寫入 儲存桶 JSON 權威副本', async () => {
    const doc = docOf(1);
    expect(doc).toMatchObject({ body: 'first body', number: 1, state: 'open' });
    expect(doc.comments).toEqual([]);
  });

  it('空白標題回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { title: '   ' },
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_issue');
  });

  it('缺少標題回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: {},
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('列出與讀取', () => {
  it('讀權協作者可列出', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('匿名列出私有 repo 的 issues 回 404 以隱藏存在性', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues',
    });
    expect(res.statusCode).toBe(404);
  });

  it('匿名可列出公開 repo 的 issues', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/iss-owner/open-notes/issues',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });

  it('可依狀態篩選', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues?state=closed',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });

  it('非法狀態參數回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues?state=zombie',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_state');
  });

  it('取得單一 issue 帶出留言', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues/1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issue.number).toBe(1);
  });

  it('不存在的編號回 404', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'GET',
      url: '/api/repos/iss-owner/notes/issues/9999',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('留言與狀態', () => {
  it('擁有者留言回 204 且 JSON 同步', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { body: 'a comment' },
      url: '/api/repos/iss-owner/notes/issues/1/comments',
    });
    expect(res.statusCode).toBe(204);
    expect(docOf(1).comments).toEqual([
      expect.objectContaining({ author: 'iss-owner', body: 'a comment' }),
    ]);
  });

  it('只有讀權者不得留言，回 403', async () => {
    const res = await ctx.app.inject({
      cookies: auth(readerCookie),
      method: 'POST',
      payload: { body: 'nope' },
      url: '/api/repos/iss-owner/notes/issues/1/comments',
    });
    expect(res.statusCode).toBe(403);
  });

  it('空白留言回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { body: '  ' },
      url: '/api/repos/iss-owner/notes/issues/1/comments',
    });
    expect(res.statusCode).toBe(400);
  });

  it('關閉 issue 寫入 closedAt 且 JSON 同步', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'PATCH',
      payload: { state: 'closed' },
      url: '/api/repos/iss-owner/notes/issues/1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issue.state).toBe('closed');
    expect(res.json().issue.closedAt).not.toBeNull();
    expect(docOf(1).state).toBe('closed');
  });

  it('重開 issue 清除 closedAt', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'PATCH',
      payload: { state: 'open' },
      url: '/api/repos/iss-owner/notes/issues/1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issue.closedAt).toBeNull();
    expect(docOf(1).closedAt).toBeNull();
  });

  it('未知狀態回 400', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'PATCH',
      payload: { state: 'archived' },
      url: '/api/repos/iss-owner/notes/issues/1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_state');
  });

  it('對不存在的編號留言回 404', async () => {
    const res = await ctx.app.inject({
      cookies: auth(ownerCookie),
      method: 'POST',
      payload: { body: 'ghost' },
      url: '/api/repos/iss-owner/notes/issues/4242/comments',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('守門並行', () => {
  it('repo 查詢與工作階段查詢並行發出', async () => {
    const prisma = ctx.prisma;
    const repoFind = prisma.repo.findFirst.bind(prisma.repo);
    const sessionFind = prisma.session.findUnique.bind(prisma.session);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let repoCalls = 0;
    let sessionCalls = 0;

    const repoSpy = vi.spyOn(prisma.repo, 'findFirst').mockImplementation(
      (async (...args: Parameters<typeof repoFind>) => {
        repoCalls += 1;
        await gate;
        return repoFind(...args);
      }) as unknown as typeof prisma.repo.findFirst,
    );
    const sessionSpy = vi.spyOn(prisma.session, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof sessionFind>) => {
        sessionCalls += 1;
        await gate;
        return sessionFind(...args);
      }) as unknown as typeof prisma.session.findUnique,
    );

    try {
      const pending = ctx.app.inject({
        cookies: auth(ownerCookie),
        method: 'GET',
        url: '/api/repos/iss-owner/notes/issues',
      });
      await vi.waitFor(() => {
        if (repoCalls < 1 || sessionCalls < 1) {
          throw new Error(`repo=${repoCalls} session=${sessionCalls}`);
        }
      });
      release?.();
      const res = await pending;
      expect(res.statusCode).toBe(200);
    } finally {
      repoSpy.mockRestore();
      sessionSpy.mockRestore();
    }
  });
});
