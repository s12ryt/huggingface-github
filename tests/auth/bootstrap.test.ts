// tests/auth/bootstrap.test.ts
// 驗收 agent/question.md「多用戶系統 — 管理員預設帳號」：
//   admin / s12ryt-huggingface-github 首啟建立、強制改密、冪等、不覆寫既有帳號。
// 1~40  : 常數與預設值契約
// 42~120: 首啟建立行為
// 122~200: 冪等與不覆寫
// 202~260: 改密與解除 mustChangePassword

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  changePassword,
  ensureAdminAccount,
} from '@/auth/bootstrap.js';
import { verifyPassword } from '@/auth/password.js';

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('管理員預設帳號常數', () => {
  it('使用者名稱為 admin', () => {
    expect(DEFAULT_ADMIN_USERNAME).toBe('admin');
  });

  it('預設密碼為 s12ryt-huggingface-github', () => {
    expect(DEFAULT_ADMIN_PASSWORD).toBe('s12ryt-huggingface-github');
  });
});

describe('首啟建立', () => {
  it('空資料庫時建立 admin 並回報 created', async () => {
    const result = await ensureAdminAccount(db.prisma);

    expect(result.created).toBe(true);
    expect(result.username).toBe('admin');

    const user = await db.prisma.user.findUnique({ where: { username: 'admin' } });
    expect(user).not.toBeNull();
    expect(user?.role).toBe('admin');
    expect(user?.isActive).toBe(true);
  });

  it('建立的 admin 必須標記強制改密', async () => {
    const user = await db.prisma.user.findUnique({ where: { username: 'admin' } });
    expect(user?.mustChangePassword).toBe(true);
  });

  it('預設密碼可通過驗證且資料庫只存雜湊', async () => {
    const user = await db.prisma.user.findUnique({ where: { username: 'admin' } });
    expect(user?.passwordHash).not.toContain(DEFAULT_ADMIN_PASSWORD);
    await expect(verifyPassword(user?.passwordHash ?? '', DEFAULT_ADMIN_PASSWORD)).resolves.toBe(
      true,
    );
  });

  it('回傳結果不得外漏密碼或雜湊', async () => {
    const fresh = createTestDb();
    try {
      const result = await ensureAdminAccount(fresh.prisma);
      expect(Object.keys(result).sort()).toEqual(['created', 'userId', 'username']);
    } finally {
      await fresh.close();
    }
  });

  it('可用自訂密碼建立種子帳號', async () => {
    const fresh = createTestDb();
    try {
      await ensureAdminAccount(fresh.prisma, { password: 'custom-admin-pass' });
      const user = await fresh.prisma.user.findUnique({ where: { username: 'admin' } });
      await expect(verifyPassword(user?.passwordHash ?? '', 'custom-admin-pass')).resolves.toBe(
        true,
      );
      await expect(verifyPassword(user?.passwordHash ?? '', DEFAULT_ADMIN_PASSWORD)).resolves.toBe(
        false,
      );
    } finally {
      await fresh.close();
    }
  });

  it('自訂密碼仍須通過密碼政策', async () => {
    const fresh = createTestDb();
    try {
      await expect(ensureAdminAccount(fresh.prisma, { password: 'short' })).rejects.toThrow(
        /Password rejected/,
      );
    } finally {
      await fresh.close();
    }
  });
});

describe('冪等與不覆寫', () => {
  it('第二次呼叫回報 created=false', async () => {
    const result = await ensureAdminAccount(db.prisma);
    expect(result.created).toBe(false);
  });

  it('重複呼叫不會產生第二個 admin', async () => {
    await ensureAdminAccount(db.prisma);
    const count = await db.prisma.user.count({ where: { username: 'admin' } });
    expect(count).toBe(1);
  });

  it('既有 admin 已改過的密碼不得被重設回預設值', async () => {
    const fresh = createTestDb();
    try {
      await ensureAdminAccount(fresh.prisma);
      await changePassword(fresh.prisma, 'admin', 'operator-chosen-pass');

      await ensureAdminAccount(fresh.prisma);

      const user = await fresh.prisma.user.findUnique({ where: { username: 'admin' } });
      await expect(verifyPassword(user?.passwordHash ?? '', 'operator-chosen-pass')).resolves.toBe(
        true,
      );
      await expect(verifyPassword(user?.passwordHash ?? '', DEFAULT_ADMIN_PASSWORD)).resolves.toBe(
        false,
      );
    } finally {
      await fresh.close();
    }
  });

  it('既有 admin 被停用後不得被種子程序偷偷啟用', async () => {
    const fresh = createTestDb();
    try {
      await ensureAdminAccount(fresh.prisma);
      await fresh.prisma.user.update({
        where: { username: 'admin' },
        data: { isActive: false },
      });

      await ensureAdminAccount(fresh.prisma);

      const user = await fresh.prisma.user.findUnique({ where: { username: 'admin' } });
      expect(user?.isActive).toBe(false);
    } finally {
      await fresh.close();
    }
  });
});

describe('改密流程', () => {
  it('改密後解除 mustChangePassword 標記', async () => {
    const fresh = createTestDb();
    try {
      await ensureAdminAccount(fresh.prisma);
      await changePassword(fresh.prisma, 'admin', 'brand-new-password');

      const user = await fresh.prisma.user.findUnique({ where: { username: 'admin' } });
      expect(user?.mustChangePassword).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it('改密會撤銷該使用者所有既有工作階段', async () => {
    const fresh = createTestDb();
    try {
      const { userId } = await ensureAdminAccount(fresh.prisma);
      await fresh.prisma.session.create({
        data: {
          userId,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await changePassword(fresh.prisma, 'admin', 'brand-new-password');

      const remaining = await fresh.prisma.session.count({ where: { userId } });
      expect(remaining).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it('新密碼不符政策時拒絕且不動原密碼', async () => {
    const fresh = createTestDb();
    try {
      await ensureAdminAccount(fresh.prisma);
      await expect(changePassword(fresh.prisma, 'admin', 'tiny')).rejects.toThrow(
        /Password rejected/,
      );

      const user = await fresh.prisma.user.findUnique({ where: { username: 'admin' } });
      await expect(verifyPassword(user?.passwordHash ?? '', DEFAULT_ADMIN_PASSWORD)).resolves.toBe(
        true,
      );
    } finally {
      await fresh.close();
    }
  });

  it('使用者不存在時回 false', async () => {
    const fresh = createTestDb();
    try {
      await expect(changePassword(fresh.prisma, 'ghost', 'brand-new-password')).resolves.toBe(
        false,
      );
    } finally {
      await fresh.close();
    }
  });
});
