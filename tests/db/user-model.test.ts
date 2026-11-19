/**
 * 階段 2 — 使用者與邀請碼資料模型契約測試（對真實 SQLite 驗證）。
 *
 * 驗收依據：agent/question.md「多用戶系統」與「邀請碼可配置參數」。
 *
 * 測試涵蓋：
 *   - User                第 30 行：username 唯一、安全預設值（role/mustChangePassword/isActive）
 *   - Session             第 72 行：tokenHash 唯一、刪除使用者級聯清除工作階段
 *   - PersonalAccessToken 第 99 行：tokenHash 唯一、同使用者同名唯一
 *   - InviteCode          第 136 行：codeHash 唯一、可配置參數預設值
 *   - InviteCodeUse       第 178 行：同一邀請碼同一人僅能記錄一次、級聯清除
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../helpers/db.js';

let db: TestDb;
let prisma: PrismaClient;

beforeAll(() => {
  db = createTestDb();
  prisma = db.prisma;
});

afterAll(async () => {
  await db.close();
});

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${++seq}`;

async function makeUser(username = uniq('user')) {
  return prisma.user.create({ data: { username, passwordHash: 'hash' } });
}

describe('User 模型', () => {
  it('username 必須唯一', async () => {
    await makeUser('duplicate-name');
    await expect(makeUser('duplicate-name')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('採用安全預設值：一般角色、無需改密、啟用中', async () => {
    const user = await makeUser();
    expect(user.role).toBe('user');
    expect(user.mustChangePassword).toBe(false);
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('可建立 admin 角色並標記必須改密', async () => {
    const user = await prisma.user.create({
      data: {
        username: uniq('admin'),
        passwordHash: 'hash',
        role: 'admin',
        mustChangePassword: true,
      },
    });
    expect(user.role).toBe('admin');
    expect(user.mustChangePassword).toBe(true);
  });

  it('不儲存明文密碼欄位，僅有 passwordHash', async () => {
    const user = await makeUser();
    expect(Object.keys(user)).toContain('passwordHash');
    expect(Object.keys(user)).not.toContain('password');
  });
});

describe('Session 模型', () => {
  it('tokenHash 必須唯一', async () => {
    const user = await makeUser();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await prisma.session.create({ data: { userId: user.id, tokenHash: 'session-dup', expiresAt } });
    await expect(
      prisma.session.create({ data: { userId: user.id, tokenHash: 'session-dup', expiresAt } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('刪除使用者時級聯清除其工作階段', async () => {
    const user = await makeUser();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: uniq('tok'), expiresAt: new Date(Date.now() + 1000) },
    });
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('PersonalAccessToken 模型', () => {
  it('tokenHash 必須唯一', async () => {
    const user = await makeUser();
    await prisma.personalAccessToken.create({
      data: { userId: user.id, name: 'a', tokenHash: 'pat-dup', tokenPrefix: 'odgp_aaaa' },
    });
    await expect(
      prisma.personalAccessToken.create({
        data: { userId: user.id, name: 'b', tokenHash: 'pat-dup', tokenPrefix: 'odgp_bbbb' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('同一使用者不可有同名 token', async () => {
    const user = await makeUser();
    await prisma.personalAccessToken.create({
      data: { userId: user.id, name: 'ci', tokenHash: uniq('pat'), tokenPrefix: uniq('odgp_') },
    });
    await expect(
      prisma.personalAccessToken.create({
        data: { userId: user.id, name: 'ci', tokenHash: uniq('pat'), tokenPrefix: uniq('odgp_') },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('預設僅具 repo 範圍且未撤銷', async () => {
    const user = await makeUser();
    const pat = await prisma.personalAccessToken.create({
      data: { userId: user.id, name: uniq('t'), tokenHash: uniq('pat'), tokenPrefix: uniq('odgp_') },
    });
    expect(pat.scopes).toBe('repo');
    expect(pat.revokedAt).toBeNull();
    expect(pat.lastUsedAt).toBeNull();
  });
});

describe('InviteCode 模型', () => {
  async function makeInvite(data: Record<string, unknown> = {}) {
    const admin = await makeUser(uniq('inviter'));
    return prisma.inviteCode.create({
      data: {
        codeHash: uniq('code-hash-'),
        codePrefix: 'ABCD',
        createdById: admin.id,
        ...data,
      },
    });
  }

  it('codeHash 必須唯一', async () => {
    await makeInvite({ codeHash: 'invite-dup' });
    await expect(makeInvite({ codeHash: 'invite-dup' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('可配置參數具保守預設：單次使用、一般角色、未撤銷、無期限', async () => {
    const invite = await makeInvite();
    expect(invite.maxUses).toBe(1);
    expect(invite.usedCount).toBe(0);
    expect(invite.role).toBe('user');
    expect(invite.revokedAt).toBeNull();
    expect(invite.expiresAt).toBeNull();
    expect(invite.note).toBeNull();
    expect(invite.usernamePattern).toBeNull();
  });

  it('支援管理員自訂有效期、使用次數、角色、備註與用戶名規則', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const invite = await makeInvite({
      maxUses: 10,
      role: 'admin',
      note: '給 QA 團隊',
      usernamePattern: '^qa-[a-z0-9]{3,16}$',
      expiresAt,
    });
    expect(invite.maxUses).toBe(10);
    expect(invite.role).toBe('admin');
    expect(invite.note).toBe('給 QA 團隊');
    expect(invite.usernamePattern).toBe('^qa-[a-z0-9]{3,16}$');
    expect(invite.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});

describe('InviteCodeUse 模型', () => {
  async function makeInviteWithOwner() {
    const admin = await makeUser(uniq('owner'));
    const invite = await prisma.inviteCode.create({
      data: { codeHash: uniq('ch-'), codePrefix: 'WXYZ', createdById: admin.id, maxUses: 5 },
    });
    return invite;
  }

  it('同一邀請碼同一使用者僅能記錄一次', async () => {
    const invite = await makeInviteWithOwner();
    const user = await makeUser();
    await prisma.inviteCodeUse.create({ data: { inviteCodeId: invite.id, userId: user.id } });
    await expect(
      prisma.inviteCodeUse.create({ data: { inviteCodeId: invite.id, userId: user.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('刪除邀請碼時級聯清除使用紀錄', async () => {
    const invite = await makeInviteWithOwner();
    const user = await makeUser();
    await prisma.inviteCodeUse.create({ data: { inviteCodeId: invite.id, userId: user.id } });
    await prisma.inviteCode.delete({ where: { id: invite.id } });
    expect(await prisma.inviteCodeUse.count({ where: { inviteCodeId: invite.id } })).toBe(0);
  });
});
