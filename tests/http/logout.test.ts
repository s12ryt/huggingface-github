/**
 * 登出撤銷驗收：登出後 session 必須立即失效（cookie 不可再用、DB 列刪除）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser, TEST_PASSWORD } from '../helpers/auth.js';

describe('登出撤銷', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let cookie = '';

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const user = await seedUser(prisma, 'bye-user');
    cookie = await loginCookie(app, 'bye-user');
    expect(user.id).toBeTruthy();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('登出前 session 有效', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', cookies: { odg_session: cookie.replace('odg_session=', '') } });
    expect(res.statusCode).toBe(200);
  });

  it('登出後同一 cookie 立即失效回 401', async () => {
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { odg_session: cookie.replace('odg_session=', '') },
    });
    expect(out.statusCode).toBe(204);

    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { odg_session: cookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('登出後資料庫不留 session 列', async () => {
    const count = await prisma.session.count({ where: { user: { username: 'bye-user' } } });
    expect(count).toBe(0);
  });
});

describe('登出冪等', () => {
  it('未知 token 登出仍回 204 且不影響其他 session', async () => {
    const ctx = await createTestApp({ registrationMode: 'closed' });
    try {
      await seedUser(ctx.prisma, 'bye-keeper', 'user', TEST_PASSWORD);
      const keep = await loginCookie(ctx.app, 'bye-keeper');
      const out = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { odg_session: 'odgs_totallyunknown' },
      });
      expect(out.statusCode).toBe(204);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { odg_session: keep.replace('odg_session=', '') },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
