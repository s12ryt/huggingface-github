// 驗收：帳號自助端點（階段 5b）
//   改密流程      — POST /api/auth/password（第 20 行）
//   PAT 簽發與列表 — POST/GET /api/tokens（第 95 行）
//   PAT 撤銷與使用 — DELETE /api/tokens/:id、Bearer 認證（第 170 行）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { bearer, loginCookie, seedUser, TEST_PASSWORD } from '../helpers/auth.js';

let ctx: TestApp;
let cookie: string;

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'closed' });
  await seedUser(ctx.prisma, 'owner');
  cookie = await loginCookie(ctx.app, 'owner');
});

afterAll(async () => {
  await ctx.close();
});

describe('改密流程', () => {
  it('未登入時拒絕改密', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'another-pass', newPasswordConfirm: 'another-pass' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
  });

  it('當前密碼錯誤時拒絕且不洩漏細節', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'wrong-password', newPassword: 'another-pass', newPasswordConfirm: 'another-pass' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('兩次新密碼不一致時拒絕', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'another-pass', newPasswordConfirm: 'other-pass' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'password_mismatch' });
  });

  it('新密碼不符政策時拒絕', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'short', newPasswordConfirm: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'weak_password' });
  });

  it('改密成功後舊工作階段失效且新密碼可登入', async () => {
    await seedUser(ctx.prisma, 'rotator');
    const rotatorCookie = await loginCookie(ctx.app, 'rotator');

    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: rotatorCookie },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass', newPasswordConfirm: 'brand-new-pass' },
    });
    expect(changed.statusCode).toBe(204);

    const reused = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: rotatorCookie } });
    expect(reused.statusCode).toBe(401);

    const fresh = await loginCookie(ctx.app, 'rotator', 'brand-new-pass');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: fresh } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(false);
  });
});

describe('PAT 簽發與列表', () => {
  it('未登入時拒絕列出憑證', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/tokens' });

    expect(response.statusCode).toBe(401);
  });

  it('簽發後只回傳一次明文且資料庫不留明文', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'laptop' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.token).toMatch(/^odgp_/);
    expect(body.scopes).toEqual(['repo']);
    expect(body.displayPrefix).toBe(body.token.slice(0, 12));

    const rows = await ctx.prisma.personalAccessToken.findMany({ where: { name: 'laptop' } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.token);
  });

  it('可指定多個合法 scope', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'ci', scopes: ['admin', 'repo'] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().scopes).toEqual(['repo', 'admin']);
  });

  it('非法 scope 遭拒', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'bad-scope', scopes: ['root'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_scope' });
  });

  it('同名憑證遭拒', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'dup' } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'dup' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'duplicate_token_name' });
  });

  it('缺少名稱時遭拒', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_payload' });
  });

  it('列表不外漏雜湊與明文', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const raw = response.body.toLowerCase();
    expect(raw).not.toContain('tokenhash');
    expect(response.json().tokens.length).toBeGreaterThan(0);
    for (const token of response.json().tokens) {
      expect(Object.keys(token)).not.toContain('tokenHash');
    }
  });
});

describe('PAT 撤銷與 Bearer 認證', () => {
  it('可用 Bearer 憑證存取受保護端點', async () => {
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'bearer-ok' },
    });
    const token = issued.json().token as string;

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: bearer(token) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe('owner');
  });

  it('撤銷後憑證立即失效且重複撤銷回 404', async () => {
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'revoke-me' },
    });
    const { id, token } = issued.json() as { id: string; token: string };

    const revoked = await ctx.app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: { cookie } });
    expect(revoked.statusCode).toBe(204);

    const reused = await ctx.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: bearer(token) },
    });
    expect(reused.statusCode).toBe(401);

    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it('不得撤銷他人憑證', async () => {
    await seedUser(ctx.prisma, 'stranger');
    const strangerCookie = await loginCookie(ctx.app, 'stranger');
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: strangerCookie },
      payload: { name: 'private-token' },
    });
    const id = issued.json().id as string;

    const response = await ctx.app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: { cookie } });

    expect(response.statusCode).toBe(404);
    const row = await ctx.prisma.personalAccessToken.findUnique({ where: { id } });
    expect(row?.revokedAt).toBeNull();
  });

  it('偽造的 Bearer 憑證遭拒', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: bearer('odgp_forged-token-value') },
    });

    expect(response.statusCode).toBe(401);
  });
});
