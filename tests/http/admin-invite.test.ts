// 驗收：管理員邀請碼端點（階段 6b）
//   權限守門       — 未登入 401、非管理員 403（第 22 行）
//   產生與參數配置 — POST /api/admin/invites（第 52 行）
//   列表與撤銷     — GET/DELETE /api/admin/invites（第 136 行）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser } from '../helpers/auth.js';

let ctx: TestApp;
let adminCookie: string;
let userCookie: string;

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'invite' });
  await seedUser(ctx.prisma, 'root-admin', 'admin');
  await seedUser(ctx.prisma, 'plain-user');
  adminCookie = await loginCookie(ctx.app, 'root-admin');
  userCookie = await loginCookie(ctx.app, 'plain-user');
});

afterAll(async () => {
  await ctx.close();
});

describe('邀請碼端點權限', () => {
  it('未登入時拒絕產生', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/invites', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
  });

  it('一般使用者不得產生邀請碼', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: userCookie },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
    expect(await ctx.prisma.inviteCode.count()).toBe(0);
  });

  it('一般使用者不得列出邀請碼', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/invites',
      headers: { cookie: userCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('產生邀請碼與參數配置', () => {
  it('使用保守預設值產生', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'codePrefix', 'id']);
    expect(body.code).toMatch(/^odgi_/);

    const row = await ctx.prisma.inviteCode.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.maxUses).toBe(1);
    expect(row.role).toBe('user');
    expect(row.expiresAt).toBeNull();
    expect(row.usernamePattern).toBeNull();
  });

  it('資料庫不保留明文邀請碼', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: { note: 'no-plaintext' },
    });
    const code = response.json().code as string;

    const rows = await ctx.prisma.inviteCode.findMany({ where: { note: 'no-plaintext' } });
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('可完整配置各項參數', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: {
        role: 'admin',
        maxUses: 25,
        expiresAt,
        note: '給 QA 團隊',
        usernamePattern: '^qa-[a-z]{2,10}$',
      },
    });

    expect(response.statusCode).toBe(201);
    const row = await ctx.prisma.inviteCode.findUniqueOrThrow({ where: { id: response.json().id } });
    expect(row.role).toBe('admin');
    expect(row.maxUses).toBe(25);
    expect(row.note).toBe('給 QA 團隊');
    expect(row.usernamePattern).toBe('^qa-[a-z]{2,10}$');
    expect(row.expiresAt?.toISOString()).toBe(expiresAt);
  });

  it.each([
    ['非法角色', { role: 'root' }],
    ['零使用次數', { maxUses: 0 }],
    ['小數使用次數', { maxUses: 1.5 }],
    ['無法編譯的規則', { usernamePattern: '^[a-z' }],
    ['已過期的期限', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['無法解析的期限', { expiresAt: 'not-a-date' }],
  ])('拒絕%s', async (_label, payload) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_invite_params' });
  });
});

describe('列表與撤銷', () => {
  it('列表不外漏雜湊且帶出配額資訊', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.toLowerCase()).not.toContain('codehash');
    const [first] = response.json().invites as Array<Record<string, unknown>>;
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).not.toContain('codeHash');
    expect(first).toHaveProperty('maxUses');
    expect(first).toHaveProperty('usedCount');
  });

  it('撤銷成功後重複撤銷回 404', async () => {
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: { note: 'to-revoke' },
    });
    const id = issued.json().id as string;

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/invites/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(revoked.statusCode).toBe(204);

    const row = await ctx.prisma.inviteCode.findUniqueOrThrow({ where: { id } });
    expect(row.revokedAt).not.toBeNull();

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/invites/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it('撤銷後的邀請碼無法用於註冊', async () => {
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { id, code } = issued.json() as { id: string; code: string };
    await ctx.app.inject({ method: 'DELETE', url: `/api/admin/invites/${id}`, headers: { cookie: adminCookie } });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'late-comer', password: 'password123', passwordConfirm: 'password123', inviteCode: code },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invite_invalid' });
  });

  it('一般使用者不得撤銷邀請碼', async () => {
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const id = issued.json().id as string;

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/invites/${id}`,
      headers: { cookie: userCookie },
    });

    expect(response.statusCode).toBe(403);
    const row = await ctx.prisma.inviteCode.findUniqueOrThrow({ where: { id } });
    expect(row.revokedAt).toBeNull();
  });
});
