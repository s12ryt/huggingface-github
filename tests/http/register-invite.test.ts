/**
 * 邀請碼註冊模式驗收。
 * - 無碼/錯碼/撤銷碼回應一致（防枚舉）
 * - 成功兌換寫入使用紀錄並套用授予角色
 * - 註冊失敗不得消耗配額
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createInviteCode } from '@/invite/code.js';

import { createTestApp, type TestApp } from '../helpers/app.js';

const good = { password: 'password123', passwordConfirm: 'password123' };

describe('邀請碼註冊', () => {
  let t: TestApp;
  let adminId: string;

  beforeAll(async () => {
    t = await createTestApp({ registrationMode: 'invite' });
    const admin = await t.prisma.user.create({
      data: { username: 'root-admin', passwordHash: '$argon2id$stub', role: 'admin' },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('註冊模式查詢回報 invite', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/registration' });
    expect(res.json()).toEqual({ mode: 'invite' });
  });

  it('未提供邀請碼時明確要求補上', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'nocode', ...good },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invite_required');
  });

  it('不存在的碼與已撤銷的碼回應完全相同', async () => {
    const issued = await createInviteCode(t.prisma, { createdById: adminId });
    await t.prisma.inviteCode.update({
      where: { id: issued.id },
      data: { revokedAt: new Date() },
    });

    const revoked = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'probe-a', inviteCode: issued.code, ...good },
    });
    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'probe-b', inviteCode: 'odgi_does-not-exist', ...good },
    });

    expect(revoked.statusCode).toBe(missing.statusCode);
    expect(revoked.body).toBe(missing.body);
    expect(revoked.json().error).toBe('invite_invalid');
  });

  it('有效邀請碼可完成註冊並留下使用紀錄', async () => {
    const issued = await createInviteCode(t.prisma, { createdById: adminId, maxUses: 2 });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'invited', inviteCode: issued.code, ...good },
    });

    expect(res.statusCode).toBe(201);

    const code = await t.prisma.inviteCode.findUnique({ where: { id: issued.id } });
    expect(code?.usedCount).toBe(1);

    const user = await t.prisma.user.findUnique({ where: { username: 'invited' } });
    const uses = await t.prisma.inviteCodeUse.findMany({ where: { inviteCodeId: issued.id } });
    expect(uses).toHaveLength(1);
    expect(uses[0]?.userId).toBe(user?.id);
  });

  it('邀請碼授予的角色會套用到新使用者', async () => {
    const issued = await createInviteCode(t.prisma, { createdById: adminId, role: 'admin' });

    await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'second-admin', inviteCode: issued.code, ...good },
    });

    const user = await t.prisma.user.findUnique({ where: { username: 'second-admin' } });
    expect(user?.role).toBe('admin');
  });

  it('用戶名不符邀請碼規則時給出可修正的錯誤', async () => {
    const issued = await createInviteCode(t.prisma, {
      createdById: adminId,
      usernamePattern: '^qa-[a-z]{2,10}$',
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'outsider', inviteCode: issued.code, ...good },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invite_username_not_allowed');
    expect(await t.prisma.user.count({ where: { username: 'outsider' } })).toBe(0);
  });

  it('用盡的邀請碼無法再註冊', async () => {
    const issued = await createInviteCode(t.prisma, { createdById: adminId, maxUses: 1 });

    const first = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'quota-one', inviteCode: issued.code, ...good },
    });
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'quota-two', inviteCode: issued.code, ...good },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invite_invalid');

    const code = await t.prisma.inviteCode.findUnique({ where: { id: issued.id } });
    expect(code?.usedCount).toBe(1);
  });

  it('用戶名衝突導致註冊失敗時不得消耗配額', async () => {
    await t.prisma.user.create({
      data: { username: 'occupied', passwordHash: '$argon2id$stub' },
    });
    const issued = await createInviteCode(t.prisma, { createdById: adminId, maxUses: 3 });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'occupied', inviteCode: issued.code, ...good },
    });

    expect(res.statusCode).toBe(409);

    const code = await t.prisma.inviteCode.findUnique({ where: { id: issued.id } });
    expect(code?.usedCount).toBe(0);
    expect(await t.prisma.inviteCodeUse.count({ where: { inviteCodeId: issued.id } })).toBe(0);
  });

  it('密碼政策不符時不得消耗配額', async () => {
    const issued = await createInviteCode(t.prisma, { createdById: adminId, maxUses: 3 });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'weak-invited', inviteCode: issued.code, password: 'tiny', passwordConfirm: 'tiny' },
    });

    expect(res.statusCode).toBe(400);
    const code = await t.prisma.inviteCode.findUnique({ where: { id: issued.id } });
    expect(code?.usedCount).toBe(0);
  });
});
