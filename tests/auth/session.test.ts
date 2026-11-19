/**
 * tests/auth/session.test.ts — Session 簽發與驗證驗收測試（階段 3）
 *
 * 1~45   簽發：token 前綴、DB 只存雜湊、expiresAt 由 ttl 推算
 * 46~105 驗證：有效/未知/篡改/過期/停用帳號、lastSeenAt 更新
 * 106~   撤銷與清理：單一撤銷、全裝置撤銷、過期清理
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { hashPassword } from '@/auth/password.js';
import { hashSecretToken } from '@/auth/tokens.js';
import {
  DEFAULT_SESSION_TTL_MS,
  LAST_SEEN_THROTTLE_MS,
  createSession,
  pruneExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from '@/auth/session.js';

let db: TestDb;
let seq = 0;
const uniq = (prefix: string) => `${prefix}${(seq += 1)}`;

async function makeUser(options: { isActive?: boolean } = {}) {
  return db.prisma.user.create({
    data: {
      username: uniq('user'),
      passwordHash: await hashPassword('s12ryt-huggingface-github'),
      isActive: options.isActive ?? true,
    },
  });
}

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('session 簽發', () => {
  it('預設存活時間為 30 天', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('回傳 odgs_ 前綴的 token 與到期時間', async () => {
    const user = await makeUser();
    const result = await createSession(db.prisma, { userId: user.id });
    expect(result.token.startsWith('odgs_')).toBe(true);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('資料庫只保存 token 雜湊，任何欄位都不得出現 token 明文', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    const rows = await db.prisma.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows).includes(token)).toBe(false);
    expect(rows[0]?.tokenHash).toBe(hashSecretToken(token));
  });

  it('依 ttlMs 推算 expiresAt', async () => {
    const user = await makeUser();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = await createSession(db.prisma, { userId: user.id, ttlMs: 60_000, now });
    expect(result.expiresAt.toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('保存裝置資訊以供使用者檢視登入紀錄', async () => {
    const user = await makeUser();
    await createSession(db.prisma, {
      userId: user.id,
      userAgent: 'git/2.53.0',
      ipAddress: '10.0.0.8',
    });
    const row = await db.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.userAgent).toBe('git/2.53.0');
    expect(row.ipAddress).toBe('10.0.0.8');
  });

  it('同一使用者可同時持有多個 session（多裝置）', async () => {
    const user = await makeUser();
    await createSession(db.prisma, { userId: user.id });
    await createSession(db.prisma, { userId: user.id });
    await expect(db.prisma.session.count({ where: { userId: user.id } })).resolves.toBe(2);
  });
});

describe('session 驗證', () => {
  it('有效 token 解析出使用者與 sessionId', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    const principal = await resolveSession(db.prisma, token);
    expect(principal?.user.id).toBe(user.id);
    expect(principal?.sessionId).toBeTypeOf('string');
  });

  it('解析結果不得攜帶 passwordHash', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    const principal = await resolveSession(db.prisma, token);
    expect(principal?.user).not.toHaveProperty('passwordHash');
  });

  it('未知 token 回 null', async () => {
    await expect(resolveSession(db.prisma, 'odgs_notarealtoken')).resolves.toBeNull();
  });

  it('空 token 回 null', async () => {
    await expect(resolveSession(db.prisma, '')).resolves.toBeNull();
  });

  it('被篡改一個字元的 token 回 null', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await expect(resolveSession(db.prisma, tampered)).resolves.toBeNull();
  });

  it('過期 token 回 null 並順手刪除該列', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id, ttlMs: 1_000 });
    const later = new Date(Date.now() + 2_000);
    await expect(resolveSession(db.prisma, token, later)).resolves.toBeNull();
    await expect(db.prisma.session.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it('帳號停用時 session 立即失效', async () => {
    const user = await makeUser({ isActive: false });
    const { token } = await createSession(db.prisma, { userId: user.id });
    await expect(resolveSession(db.prisma, token)).resolves.toBeNull();
  });

  // spy 與斷言合併在同一測試：Prisma model method 經 spyOn+mockRestore 不保證可還原。
  it('lastSeenAt 節流：窗內不重寫、超窗才更新', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    const before = await db.prisma.session.findFirstOrThrow({ where: { userId: user.id } });

    const update = db.prisma.session.update.bind(db.prisma.session);
    let updates = 0;
    const updateSpy = vi.spyOn(db.prisma.session, 'update').mockImplementation(
      (async (...args: Parameters<typeof update>) => {
        updates += 1;
        return update(...args);
      }) as unknown as typeof db.prisma.session.update,
    );
    const withinWindow = new Date(before.lastSeenAt.getTime() + 60_000);
    await resolveSession(db.prisma, token, withinWindow);
    expect(updates).toBe(0);

    const pastWindow = new Date(before.lastSeenAt.getTime() + LAST_SEEN_THROTTLE_MS + 1_000);
    await resolveSession(db.prisma, token, pastWindow);
    expect(updates).toBe(1);
    updateSpy.mockRestore();

    const after = await db.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(after.lastSeenAt.getTime()).toBe(pastWindow.getTime());
  });
});

describe('session 撤銷與清理', () => {
  it('撤銷後 token 失效且第二次撤銷回 false', async () => {
    const user = await makeUser();
    const { token } = await createSession(db.prisma, { userId: user.id });
    await expect(revokeSession(db.prisma, token)).resolves.toBe(true);
    await expect(resolveSession(db.prisma, token)).resolves.toBeNull();
    await expect(revokeSession(db.prisma, token)).resolves.toBe(false);
  });

  it('撤銷全部 session 回已刪除筆數', async () => {
    const user = await makeUser();
    await createSession(db.prisma, { userId: user.id });
    await createSession(db.prisma, { userId: user.id });
    await expect(revokeAllSessions(db.prisma, user.id)).resolves.toBe(2);
    await expect(db.prisma.session.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it('清理只刪除已過期的 session', async () => {
    const user = await makeUser();
    const expired = await createSession(db.prisma, { userId: user.id, ttlMs: 1_000 });
    const alive = await createSession(db.prisma, { userId: user.id, ttlMs: 600_000 });
    const removed = await pruneExpiredSessions(db.prisma, new Date(Date.now() + 2_000));
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(resolveSession(db.prisma, expired.token)).resolves.toBeNull();
    await expect(resolveSession(db.prisma, alive.token)).resolves.not.toBeNull();
  });
});
