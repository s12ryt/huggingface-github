/**
 * 開放註冊模式驗收。
 * - 使用者名稱格式、保留字、大小寫去重
 * - 密碼兩次確認與密碼政策
 * - session cookie 簽發與提權注入防護
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';

const good = { password: 'password123', passwordConfirm: 'password123' };

describe('開放註冊：成功路徑', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ registrationMode: 'open' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('註冊模式查詢回報 open', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/registration' });
    expect(res.json()).toEqual({ mode: 'open' });
  });

  it('輸入用戶名與兩次密碼即可註冊', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', ...good },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ user: { id: expect.any(String), username: 'alice', role: 'user' } });
  });

  it('新使用者為一般角色且無需強制改密', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', ...good },
    });

    const user = await t.prisma.user.findUnique({ where: { username: 'bob' } });
    expect(user?.role).toBe('user');
    expect(user?.mustChangePassword).toBe(false);
    expect(user?.isActive).toBe(true);
  });

  it('回應不得外漏密碼雜湊', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'carol', ...good },
    });

    expect(res.body).not.toContain('argon2');
    expect(res.body).not.toContain('passwordHash');
  });

  it('註冊後簽發 HttpOnly session cookie 並可直接取用身分', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dave', ...good },
    });

    const cookie = res.cookies.find((c) => c.name === 'odg_session');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe('/');
    expect(cookie?.sameSite?.toLowerCase()).toBe('strict');
    expect(cookie?.value).not.toContain('dave');

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { odg_session: cookie!.value },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('dave');
  });

  it('body 夾帶 role=admin 不得提權', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'eve', role: 'admin', isActive: true, ...good },
    });

    const user = await t.prisma.user.findUnique({ where: { username: 'eve' } });
    expect(user?.role).toBe('user');
  });

  it('open 模式忽略多餘的邀請碼欄位', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'frank', inviteCode: 'odgi_whatever', ...good },
    });

    expect(res.statusCode).toBe(201);
  });
});

describe('開放註冊：輸入驗證', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ registrationMode: 'open' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('兩次密碼不一致時拒絕且不建立使用者', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'mismatch', password: 'password123', passwordConfirm: 'password124' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('password_mismatch');
    expect(await t.prisma.user.count({ where: { username: 'mismatch' } })).toBe(0);
  });

  it('密碼不符政策時拒絕', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'weakpass', password: 'short', passwordConfirm: 'short' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('weak_password');
  });

  it('錯誤回應不得包含密碼明文', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'leaky', password: 'sup3rsecret', passwordConfirm: 'other-value' },
    });

    expect(res.body).not.toContain('sup3rsecret');
    expect(res.body).not.toContain('other-value');
  });

  it('用戶名已存在時回 409', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'taken', ...good },
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'taken', ...good },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('username_taken');
  });

  it('大小寫不同視為同一個用戶名', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'MixedCase', ...good },
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'mixedcase', ...good },
    });

    expect(res.statusCode).toBe(409);
    expect(await t.prisma.user.count({ where: { username: 'mixedcase' } })).toBe(1);
  });

  it.each(['ab', 'has space', '-lead', 'trail-', 'bad$char', 'a'.repeat(40)])(
    '拒絕非法用戶名 %s',
    async (username) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, ...good },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_username');
    },
  );

  it.each(['api', 'admin-api', 'login', 'logout', 'register', 'static'])(
    '拒絕保留用戶名 %s',
    async (username) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, ...good },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('reserved_username');
    },
  );

  it('缺少欄位時回 invalid_payload', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
  });

  it('超出速率限制後回 429', async () => {
    const limited = await createTestApp({ registrationMode: 'open', rateLimitMax: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { username: `flood${i}`, ...good },
        });
        codes.push(res.statusCode);
      }

      expect(codes).toContain(429);
    } finally {
      await limited.close();
    }
  });
});
