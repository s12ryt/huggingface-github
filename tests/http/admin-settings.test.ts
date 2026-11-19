// 驗收：管理員註冊模式切換（階段 6b）
//   權限守門       — 未登入 401、非管理員 403（第 21 行）
//   讀取與切換模式 — GET/PATCH /api/admin/settings（第 56 行）
//   切換後的實際行為 — 註冊端點隨模式開關（第 108 行）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser } from '../helpers/auth.js';

let ctx: TestApp;
let adminCookie: string;
let userCookie: string;

const setMode = async (mode: string): Promise<number> => {
  const response = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/admin/settings',
    headers: { cookie: adminCookie },
    payload: { registrationMode: mode },
  });
  return response.statusCode;
};

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'closed' });
  await seedUser(ctx.prisma, 'root-admin', 'admin');
  await seedUser(ctx.prisma, 'plain-user');
  adminCookie = await loginCookie(ctx.app, 'root-admin');
  userCookie = await loginCookie(ctx.app, 'plain-user');
});

afterAll(async () => {
  await ctx.close();
});

describe('設定端點權限', () => {
  it('未登入時拒絕讀取', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/settings' });

    expect(response.statusCode).toBe(401);
  });

  it('一般使用者不得讀取', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: userCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('一般使用者不得切換模式且模式不受影響', async () => {
    expect(await setMode('closed')).toBe(200);

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { cookie: userCookie },
      payload: { registrationMode: 'open' },
    });

    expect(response.statusCode).toBe(403);
    const probe = await ctx.app.inject({ method: 'GET', url: '/api/auth/registration' });
    expect(probe.json()).toEqual({ mode: 'closed' });
  });
});

describe('讀取與切換模式', () => {
  it('未設定時回落到環境組態的模式', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('registrationMode');
  });

  it('切換後同時反映在管理端與公開端', async () => {
    expect(await setMode('open')).toBe(200);

    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
    });
    expect(admin.json()).toEqual({ registrationMode: 'open' });

    const publicProbe = await ctx.app.inject({ method: 'GET', url: '/api/auth/registration' });
    expect(publicProbe.json()).toEqual({ mode: 'open' });
  });

  it.each(['disabled', '', 'OPEN ', 'invite-only'])('拒絕非法模式 %j', async (mode) => {
    expect(await setMode('closed')).toBe(200);

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
      payload: { registrationMode: mode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_mode' });
    const probe = await ctx.app.inject({ method: 'GET', url: '/api/auth/registration' });
    expect(probe.json()).toEqual({ mode: 'closed' });
  });
});

describe('切換後的註冊端點行為', () => {
  const credentials = { password: 'password123', passwordConfirm: 'password123' };

  it('切成開放後可直接註冊', async () => {
    expect(await setMode('open')).toBe(200);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'switched-open', ...credentials },
    });

    expect(response.statusCode).toBe(201);
  });

  it('切成邀請制後必須帶邀請碼', async () => {
    expect(await setMode('invite')).toBe(200);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'needs-invite', ...credentials },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invite_required' });
  });

  it('切成關閉後註冊端點與不存在路徑無從區分', async () => {
    expect(await setMode('closed')).toBe(200);

    const register = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'blocked-user', ...credentials },
    });
    const nonexistent = await ctx.app.inject({
      method: 'POST',
      url: '/api/zzz-nonexistent',
      payload: { username: 'blocked-user', ...credentials },
    });

    expect(register.statusCode).toBe(404);
    expect(register.body).toBe(nonexistent.body);
    expect(register.body.toLowerCase()).not.toContain('register');
    expect(await ctx.prisma.user.count({ where: { username: 'blocked-user' } })).toBe(0);
  });

  it('關閉期間的設定變更持久化於資料庫', async () => {
    expect(await setMode('closed')).toBe(200);

    const row = await ctx.prisma.setting.findUnique({ where: { key: 'registration.mode' } });
    expect(row?.value).toBe('closed');
  });
});
