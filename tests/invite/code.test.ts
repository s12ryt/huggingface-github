// tests/invite/code.test.ts
// 驗收 agent/question.md「邀請碼可配置參數」與「防枚舉」：
//   有效期 / 使用次數 / 角色 / 備註 / 用戶名規則 / 撤銷 / 使用紀錄。
// 1~45   : 產生邀請碼與參數落地
// 47~150 : 參數驗證（過期、用盡、撤銷、用戶名規則）
// 152~240: 兌換原子性與使用紀錄
// 242~300: 撤銷、列表、防枚舉一致性

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  INVITE_CODE_PREFIX,
  createInviteCode,
  listInviteCodes,
  redeemInviteCode,
  revokeInviteCode,
  validateInviteCode,
} from '@/invite/code.js';

let db: TestDb;
let adminId: string;
let seq = 0;
const uniq = (p: string) => `${p}${++seq}`;

async function makeUser(username: string, role = 'user'): Promise<string> {
  const user = await db.prisma.user.create({
    data: { username, passwordHash: '$argon2id$stub', role },
    select: { id: true },
  });
  return user.id;
}

beforeAll(async () => {
  db = createTestDb();
  adminId = await makeUser('admin', 'admin');
});

afterAll(async () => {
  await db.close();
});

describe('產生邀請碼', () => {
  it('回傳明文邀請碼與識別資訊，且不含雜湊', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });

    expect(Object.keys(issued).sort()).toEqual(['code', 'codePrefix', 'id']);
    expect(issued.code.startsWith(`${INVITE_CODE_PREFIX}_`)).toBe(true);
  });

  it('資料庫只保存雜湊，絕不保存明文', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });

    expect(JSON.stringify(row)).not.toContain(issued.code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('未指定參數時採保守預設：單次、user 角色、永不過期', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });

    expect(row.maxUses).toBe(1);
    expect(row.usedCount).toBe(0);
    expect(row.role).toBe('user');
    expect(row.expiresAt).toBeNull();
    expect(row.note).toBeNull();
    expect(row.usernamePattern).toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it('管理員可完整配置所有參數', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const issued = await createInviteCode(db.prisma, {
      createdById: adminId,
      role: 'admin',
      maxUses: 25,
      expiresAt,
      note: '給 QA 團隊',
      usernamePattern: '^qa-[a-z0-9]{3,16}$',
    });
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });

    expect(row.role).toBe('admin');
    expect(row.maxUses).toBe(25);
    expect(row.expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(row.note).toBe('給 QA 團隊');
    expect(row.usernamePattern).toBe('^qa-[a-z0-9]{3,16}$');
  });

  it('拒絕非法角色', async () => {
    await expect(
      createInviteCode(db.prisma, { createdById: adminId, role: 'root' }),
    ).rejects.toThrow(/role/i);
  });

  it('拒絕非正整數的使用次數', async () => {
    await expect(
      createInviteCode(db.prisma, { createdById: adminId, maxUses: 0 }),
    ).rejects.toThrow(/maxUses/i);
    await expect(
      createInviteCode(db.prisma, { createdById: adminId, maxUses: 1.5 }),
    ).rejects.toThrow(/maxUses/i);
  });

  it('拒絕無法編譯的用戶名規則，避免存入壞設定', async () => {
    await expect(
      createInviteCode(db.prisma, { createdById: adminId, usernamePattern: '^[a-z' }),
    ).rejects.toThrow(/usernamePattern/i);
  });

  it('拒絕已經過期的有效期，避免產生死碼', async () => {
    await expect(
      createInviteCode(db.prisma, {
        createdById: adminId,
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/expiresAt/i);
  });
});

describe('驗證邀請碼', () => {
  it('有效碼回傳可用與授予角色', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, role: 'admin' });
    const result = await validateInviteCode(db.prisma, issued.code, { username: uniq('u') });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('admin');
  });

  it('不存在的碼回傳統一的 invalid 原因', async () => {
    const result = await validateInviteCode(db.prisma, `${INVITE_CODE_PREFIX}_nope`, {
      username: uniq('u'),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('已撤銷的碼與不存在的碼回應完全相同，避免枚舉', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });
    await revokeInviteCode(db.prisma, issued.id);

    const revoked = await validateInviteCode(db.prisma, issued.code, { username: uniq('u') });
    const missing = await validateInviteCode(db.prisma, `${INVITE_CODE_PREFIX}_nope`, {
      username: uniq('u'),
    });

    expect(revoked).toEqual(missing);
  });

  it('過期的碼回傳 invalid', async () => {
    const issued = await createInviteCode(db.prisma, {
      createdById: adminId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await validateInviteCode(db.prisma, issued.code, {
      username: uniq('u'),
      now: new Date(Date.now() + 120_000),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('用盡次數的碼回傳 invalid', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, maxUses: 1 });
    await redeemInviteCode(db.prisma, { code: issued.code, userId: await makeUser(uniq('spent')) });

    const result = await validateInviteCode(db.prisma, issued.code, { username: uniq('u') });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('用戶名不符規則時回傳可區分的原因，讓持碼者能修正', async () => {
    const issued = await createInviteCode(db.prisma, {
      createdById: adminId,
      usernamePattern: '^qa-[a-z]{3,8}$',
    });

    const bad = await validateInviteCode(db.prisma, issued.code, { username: 'intruder' });
    expect(bad).toEqual({ ok: false, reason: 'username_not_allowed' });

    const good = await validateInviteCode(db.prisma, issued.code, { username: 'qa-alice' });
    expect(good.ok).toBe(true);
  });

  it('空字串與空白不得視為有效碼', async () => {
    await expect(validateInviteCode(db.prisma, '', { username: uniq('u') })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(validateInviteCode(db.prisma, '   ', { username: uniq('u') })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('兌換邀請碼', () => {
  it('兌換成功時遞增使用次數並寫入使用紀錄', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, maxUses: 3 });
    const userId = await makeUser(uniq('redeemer'));

    const result = await redeemInviteCode(db.prisma, {
      code: issued.code,
      userId,
      ipAddress: '10.0.0.7',
    });

    expect(result.ok).toBe(true);
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.usedCount).toBe(1);

    const use = await db.prisma.inviteCodeUse.findFirstOrThrow({
      where: { inviteCodeId: issued.id, userId },
    });
    expect(use.ipAddress).toBe('10.0.0.7');
  });

  it('兌換成功回傳授予角色', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, role: 'admin' });
    const result = await redeemInviteCode(db.prisma, {
      code: issued.code,
      userId: await makeUser(uniq('promoted')),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('admin');
  });

  it('超出使用次數時拒絕，且次數不得超賣', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, maxUses: 2 });
    for (let i = 0; i < 2; i += 1) {
      await redeemInviteCode(db.prisma, { code: issued.code, userId: await makeUser(uniq('ok')) });
    }

    const third = await redeemInviteCode(db.prisma, {
      code: issued.code,
      userId: await makeUser(uniq('late')),
    });

    expect(third).toEqual({ ok: false, reason: 'invalid' });
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.usedCount).toBe(2);
  });

  it('併發兌換不得突破使用上限', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, maxUses: 3 });
    const users = await Promise.all(
      Array.from({ length: 8 }, () => makeUser(uniq('race'))),
    );

    const results = await Promise.all(
      users.map((userId) => redeemInviteCode(db.prisma, { code: issued.code, userId })),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.usedCount).toBe(3);
  });

  it('同一使用者不得重複兌換同一張碼', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId, maxUses: 5 });
    const userId = await makeUser(uniq('double'));

    await redeemInviteCode(db.prisma, { code: issued.code, userId });
    const again = await redeemInviteCode(db.prisma, { code: issued.code, userId });

    expect(again).toEqual({ ok: false, reason: 'invalid' });
    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.usedCount).toBe(1);
  });

  it('無效碼兌換時不得留下任何使用紀錄', async () => {
    const before = await db.prisma.inviteCodeUse.count();
    await redeemInviteCode(db.prisma, {
      code: `${INVITE_CODE_PREFIX}_ghost`,
      userId: await makeUser(uniq('ghost')),
    });

    expect(await db.prisma.inviteCodeUse.count()).toBe(before);
  });
});

describe('撤銷與列表', () => {
  it('撤銷寫入時間戳而不刪除紀錄，保留審計軌跡', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });
    expect(await revokeInviteCode(db.prisma, issued.id)).toBe(true);

    const row = await db.prisma.inviteCode.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('重複撤銷回 false', async () => {
    const issued = await createInviteCode(db.prisma, { createdById: adminId });
    await revokeInviteCode(db.prisma, issued.id);
    expect(await revokeInviteCode(db.prisma, issued.id)).toBe(false);
  });

  it('撤銷不存在的碼回 false 而不拋錯', async () => {
    expect(await revokeInviteCode(db.prisma, 'no-such-id')).toBe(false);
  });

  it('列表帶出管理所需欄位但不外漏 codeHash', async () => {
    const fresh = createTestDb();
    try {
      const owner = await fresh.prisma.user.create({
        data: { username: 'admin', passwordHash: '$argon2id$stub', role: 'admin' },
        select: { id: true },
      });
      await createInviteCode(fresh.prisma, {
        createdById: owner.id,
        note: '列表測試',
        maxUses: 4,
      });

      const list = await listInviteCodes(fresh.prisma);
      expect(list).toHaveLength(1);
      const entry = list[0]!;
      expect(entry).not.toHaveProperty('codeHash');
      expect(entry.note).toBe('列表測試');
      expect(entry.maxUses).toBe(4);
      expect(entry.usedCount).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
