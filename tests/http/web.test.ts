/**
 * 前端頁面層測試
 *
 * 1. 頁面殼層與靜態資源（GET / 、/login、/assets/*）
 * 2. 註冊頁三模式閘門（closed 時必須 404 且與不存在路徑同形）
 * 3. 登入頁不得洩漏註冊入口（防腳本抓出註冊頁）
 * 4. repo / issues / pulls / admin 殼層
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeRegistrationMode } from '@/settings/registration.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

describe('頁面殼層與靜態資源', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('首頁回傳 HTML 文件', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
  });

  it('首頁宣告語言與視窗縮放以利行動裝置', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('lang="zh-Hant"');
    expect(res.body).toContain('name="viewport"');
  });

  it('登入頁提供帳號與密碼欄位', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="username"');
    expect(res.body).toContain('name="password"');
  });

  it('樣式表以 text/css 提供', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body.length).toBeGreaterThan(100);
  });

  it('前端腳本以 javascript 提供', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('靜態資源可被快取以降低重複傳輸', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('未知的資源名稱回 404', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/secrets.css' });
    expect(res.statusCode).toBe(404);
  });
});

describe('註冊頁三模式閘門', () => {
  it('關閉註冊時註冊頁不存在', async () => {
    const ctx = await createTestApp({ registrationMode: 'closed' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(res.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('關閉註冊時註冊頁回應與不存在的路徑完全相同', async () => {
    const ctx = await createTestApp({ registrationMode: 'closed' });
    try {
      const hidden = await ctx.app.inject({ method: 'GET', url: '/register' });
      const missing = await ctx.app.inject({ method: 'GET', url: '/zzz-no-such-page' });
      expect(hidden.statusCode).toBe(missing.statusCode);
      expect(hidden.body).toBe(missing.body);
    } finally {
      await ctx.close();
    }
  });

  it('關閉註冊時登入頁不得出現註冊入口', async () => {
    const ctx = await createTestApp({ registrationMode: 'closed' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/login' });
      expect(res.body.toLowerCase()).not.toContain('/register');
    } finally {
      await ctx.close();
    }
  });

  it('開放註冊時註冊頁要求兩次密碼', async () => {
    const ctx = await createTestApp({ registrationMode: 'open' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('name="password"');
      expect(res.body).toContain('name="passwordConfirm"');
    } finally {
      await ctx.close();
    }
  });

  it('開放註冊時登入頁提供註冊入口', async () => {
    const ctx = await createTestApp({ registrationMode: 'open' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/login' });
      expect(res.body).toContain('/register');
    } finally {
      await ctx.close();
    }
  });

  it('開放註冊時註冊頁不出現邀請碼欄位', async () => {
    const ctx = await createTestApp({ registrationMode: 'open' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(res.body).not.toContain('name="inviteCode"');
    } finally {
      await ctx.close();
    }
  });

  it('邀請碼模式的註冊頁提供邀請碼欄位', async () => {
    const ctx = await createTestApp({ registrationMode: 'invite' });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('name="inviteCode"');
    } finally {
      await ctx.close();
    }
  });

  it('註冊模式熱切換後頁面可用性隨之改變', async () => {
    const ctx = await createTestApp({ registrationMode: 'closed' });
    try {
      const before = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(before.statusCode).toBe(404);

      // 走 service 層寫入——這也是管理員介面的唯一寫入路徑，
      // 直接 upsert Setting 會繞過註冊模式快取的失效邏輯。
      await writeRegistrationMode(ctx.prisma, 'open');

      const after = await ctx.app.inject({ method: 'GET', url: '/register' });
      expect(after.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});

describe('應用頁面殼層', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it.each([
    ['/repos', 'repos'],
    ['/settings/tokens', 'tokens'],
    ['/admin', 'admin'],
  ])('%s 回傳對應的頁面殼層', async (url, marker) => {
    const res = await ctx.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`data-page="${marker}"`);
  });

  it('repo 頁面殼層帶出擁有者與名稱', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/alice/widgets' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-owner="alice"');
    expect(res.body).toContain('data-repo="widgets"');
  });

  it('issues 與 pulls 子頁面各有獨立標記', async () => {
    const issues = await ctx.app.inject({ method: 'GET', url: '/alice/widgets/issues' });
    const pulls = await ctx.app.inject({ method: 'GET', url: '/alice/widgets/pulls' });
    expect(issues.body).toContain('data-page="issues"');
    expect(pulls.body).toContain('data-page="pulls"');
  });

  it('殼層不內嵌任何伺服器端資料以避免越權洩漏', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/alice/widgets' });
    expect(res.body.toLowerCase()).not.toContain('passwordhash');
    expect(res.body).not.toContain('"users"');
  });

  it('git 傳輸路徑不會被頁面路由攔截', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/alice/widgets/info/refs' });
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain('<!doctype html>');
  });

  it('頁面殼層帶有跳至主內容的無障礙連結', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/repos' });
    expect(res.body).toContain('href="#main"');
  });
});
