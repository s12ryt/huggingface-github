/**
 * tests/auth/pat.test.ts — 個人存取權杖（PAT）驗收測試（階段 3）
 *
 * 1~55    簽發：前綴、DB 只存雜湊與顯示前綴、scope 驗證、同名衝突
 * 56~125  驗證：有效/未知/篡改/過期/已撤銷/停用帳號、lastUsedAt
 * 126~    撤銷與列表：軟撤銷保留審計、跨使用者不可撤銷、列表不外洩雜湊
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { hashPassword } from '@/auth/password.js';
import { hashSecretToken } from '@/auth/tokens.js';
import {
  DEFAULT_PAT_SCOPES,
  DuplicateTokenNameError,
  InvalidScopeError,
  PAT_LAST_USED_THROTTLE_MS,
  PAT_SCOPES,
  hasScope,
  issueAccessToken,
  listAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
} from '@/auth/pat.js';

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

describe('PAT 簽發', () => {
  it('scope 清單與預設值明確', () => {
    expect([...PAT_SCOPES]).toEqual(['repo', 'admin']);
    expect([...DEFAULT_PAT_SCOPES]).toEqual(['repo']);
  });

  it('回傳 odgp_ 前綴的 token 與顯示前綴', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: 'laptop' });
    expect(issued.token.startsWith('odgp_')).toBe(true);
    expect(issued.token.startsWith(issued.displayPrefix)).toBe(true);
  });

  it('資料庫只保存雜湊與顯示前綴，不得出現 token 明文', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: 'ci' });
    const rows = await db.prisma.personalAccessToken.findMany({ where: { userId: user.id } });
    expect(JSON.stringify(rows).includes(issued.token)).toBe(false);
    expect(rows[0]?.tokenHash).toBe(hashSecretToken(issued.token));
    expect(rows[0]?.tokenPrefix).toBe(issued.displayPrefix);
  });

  it('未指定 scope 時採用最小權限預設', async () => {
    const user = await makeUser();
    await issueAccessToken(db.prisma, { userId: user.id, name: 'default-scope' });
    const row = await db.prisma.personalAccessToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.scopes).toBe('repo');
  });

  it('多個 scope 去重並以固定順序保存', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, {
      userId: user.id,
      name: 'admin-token',
      scopes: ['admin', 'repo', 'admin'],
    });
    expect(issued.scopes).toEqual(['repo', 'admin']);
  });

  it('非法 scope 拋 InvalidScopeError 且訊息列出合法值', async () => {
    const user = await makeUser();
    await expect(
      issueAccessToken(db.prisma, { userId: user.id, name: 'bad', scopes: ['root'] }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvalidScopeError && String(error.message).includes('repo'),
    );
  });

  it('同一使用者的 token 名稱不可重複', async () => {
    const user = await makeUser();
    await issueAccessToken(db.prisma, { userId: user.id, name: 'dup' });
    await expect(
      issueAccessToken(db.prisma, { userId: user.id, name: 'dup' }),
    ).rejects.toBeInstanceOf(DuplicateTokenNameError);
  });

  it('不同使用者可使用相同 token 名稱', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await issueAccessToken(db.prisma, { userId: a.id, name: 'shared-name' });
    await expect(
      issueAccessToken(db.prisma, { userId: b.id, name: 'shared-name' }),
    ).resolves.toBeDefined();
  });
});

describe('PAT 驗證', () => {
  it('有效 token 解析出使用者與 scope 陣列', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, {
      userId: user.id,
      name: uniq('t'),
      scopes: ['repo', 'admin'],
    });
    const principal = await resolveAccessToken(db.prisma, issued.token);
    expect(principal?.user.id).toBe(user.id);
    expect(principal?.scopes).toEqual(['repo', 'admin']);
  });

  it('解析結果不得攜帶 passwordHash', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    const principal = await resolveAccessToken(db.prisma, issued.token);
    expect(principal?.user).not.toHaveProperty('passwordHash');
  });

  it('未知與空 token 皆回 null', async () => {
    await expect(resolveAccessToken(db.prisma, 'odgp_nope')).resolves.toBeNull();
    await expect(resolveAccessToken(db.prisma, '')).resolves.toBeNull();
  });

  it('被篡改的 token 回 null', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    await expect(resolveAccessToken(db.prisma, tampered)).resolves.toBeNull();
  });

  it('過期 token 回 null 但保留列以供審計', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, {
      userId: user.id,
      name: uniq('t'),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(resolveAccessToken(db.prisma, issued.token)).resolves.toBeNull();
    await expect(
      db.prisma.personalAccessToken.count({ where: { userId: user.id } }),
    ).resolves.toBe(1);
  });

  it('未設到期日的 token 永久有效', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    const far = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    await expect(resolveAccessToken(db.prisma, issued.token, far)).resolves.not.toBeNull();
  });

  it('已撤銷 token 回 null', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    await revokeAccessToken(db.prisma, { userId: user.id, tokenId: issued.id });
    await expect(resolveAccessToken(db.prisma, issued.token)).resolves.toBeNull();
  });

  it('帳號停用時 token 立即失效', async () => {
    const user = await makeUser({ isActive: false });
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    await expect(resolveAccessToken(db.prisma, issued.token)).resolves.toBeNull();
  });

  it('首次使用與超過節流窗的驗證更新 lastUsedAt', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    const first = new Date('2026-05-05T12:00:00.000Z');
    await resolveAccessToken(db.prisma, issued.token, first);
    const row = await db.prisma.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.lastUsedAt?.getTime()).toBe(first.getTime());

    const past = new Date(first.getTime() + PAT_LAST_USED_THROTTLE_MS + 1_000);
    await resolveAccessToken(db.prisma, issued.token, past);
    const updated = await db.prisma.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(updated.lastUsedAt?.getTime()).toBe(past.getTime());
  });
});

describe('PAT 撤銷與列表', () => {
  it('撤銷為軟刪除，保留列並寫入 revokedAt', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    await expect(
      revokeAccessToken(db.prisma, { userId: user.id, tokenId: issued.id }),
    ).resolves.toBe(true);
    const row = await db.prisma.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('重複撤銷回 false', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    await revokeAccessToken(db.prisma, { userId: user.id, tokenId: issued.id });
    await expect(
      revokeAccessToken(db.prisma, { userId: user.id, tokenId: issued.id }),
    ).resolves.toBe(false);
  });

  it('不得撤銷他人的 token', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: owner.id, name: uniq('t') });
    await expect(
      revokeAccessToken(db.prisma, { userId: attacker.id, tokenId: issued.id }),
    ).resolves.toBe(false);
    await expect(resolveAccessToken(db.prisma, issued.token)).resolves.not.toBeNull();
  });

  it('列表不外洩 tokenHash 且含顯示前綴與 scope 陣列', async () => {
    const user = await makeUser();
    await issueAccessToken(db.prisma, {
      userId: user.id,
      name: 'listed',
      scopes: ['repo', 'admin'],
    });
    const list = await listAccessTokens(db.prisma, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('tokenHash');
    expect(list[0]?.tokenPrefix.startsWith('odgp_')).toBe(true);
    expect(list[0]?.scopes).toEqual(['repo', 'admin']);
  });
});

describe('scope 判斷', () => {
  it('持有該 scope 回 true', () => {
    expect(hasScope(['repo'], 'repo')).toBe(true);
  });

  it('未持有回 false', () => {
    expect(hasScope(['repo'], 'admin')).toBe(false);
  });

  it('admin 涵蓋所有 scope', () => {
    expect(hasScope(['admin'], 'repo')).toBe(true);
  });
});

describe('lastUsedAt 節流（spy 測試置於檔尾）', () => {
  it('節流窗內的重複驗證不重寫 lastUsedAt', async () => {
    const user = await makeUser();
    const issued = await issueAccessToken(db.prisma, { userId: user.id, name: uniq('t') });
    const first = new Date('2026-05-05T12:00:00.000Z');
    await resolveAccessToken(db.prisma, issued.token, first);

    const update = db.prisma.personalAccessToken.update.bind(db.prisma.personalAccessToken);
    let updates = 0;
    const spy = vi.spyOn(db.prisma.personalAccessToken, 'update').mockImplementation(
      (async (...args: Parameters<typeof update>) => {
        updates += 1;
        return update(...args);
      }) as unknown as typeof db.prisma.personalAccessToken.update,
    );
    const soon = new Date(first.getTime() + 60_000);
    const principal = await resolveAccessToken(db.prisma, issued.token, soon);
    spy.mockRestore();
    expect(principal?.tokenId).toBe(issued.id);
    expect(updates).toBe(0);
    const row = await db.prisma.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.lastUsedAt?.getTime()).toBe(first.getTime());
  });
});
