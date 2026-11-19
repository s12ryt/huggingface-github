/**
 * 關閉註冊模式的隱藏性驗收。
 * - 註冊端點必須完全不存在（404，非 403/400）
 * - 任何 payload 的回應內容與 header 一致，不得被腳本指紋識別
 * - 註冊頁與 API 探測皆不得洩漏註冊功能
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';

describe('關閉註冊：端點隱藏', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ registrationMode: 'closed' });
  });

  afterAll(async () => {
    await t.close();
  });

  it('POST /api/auth/register 回 404 而不是 403 或 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'someone', password: 'password123', passwordConfirm: 'password123' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('註冊頁 /register 不存在', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/register' });
    expect(res.statusCode).toBe(404);
  });

  it('不同 payload 的回應狀態與內容完全一致', async () => {
    const payloads = [
      { username: 'alice', password: 'password123', passwordConfirm: 'password123' },
      { username: 'admin', password: 'x', passwordConfirm: 'y' },
      {},
    ];

    const results = await Promise.all(
      payloads.map((payload) =>
        t.app.inject({ method: 'POST', url: '/api/auth/register', payload }),
      ),
    );

    const first = results[0]!;
    for (const res of results) {
      expect(res.statusCode).toBe(first.statusCode);
      expect(res.body).toBe(first.body);
    }
  });

  it('404 回應不得洩漏請求路徑或註冊字樣', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });

    expect(res.body.toLowerCase()).not.toContain('register');
    expect(res.body.toLowerCase()).not.toContain('invite');
  });

  it('未知路徑與註冊路徑的 404 回應無法區分', async () => {
    const unknown = await t.app.inject({ method: 'POST', url: '/api/zzz-nonexistent', payload: {} });
    const register = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });

    expect(register.statusCode).toBe(unknown.statusCode);
    expect(register.body).toBe(unknown.body);
  });

  it('回應 header 不得洩漏註冊模式', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });
    const names = Object.keys(res.headers).map((n) => n.toLowerCase());

    expect(names.some((n) => n.includes('registration'))).toBe(false);
    expect(names.some((n) => n.includes('invite'))).toBe(false);
  });

  it('GET 與 OPTIONS 探測同樣回 404', async () => {
    for (const method of ['GET', 'OPTIONS'] as const) {
      const res = await t.app.inject({ method, url: '/api/auth/register' });
      expect(res.statusCode).toBe(404);
    }
  });

  it('註冊模式查詢只回報已關閉，不提供註冊欄位資訊', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/registration' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'closed' });
  });

  it('登入端點仍然可用', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'password123' },
    });

    expect(res.statusCode).toBe(401);
  });
});
