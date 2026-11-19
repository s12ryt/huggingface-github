/**
 * 階段 2 — 倉庫、協作者與 ref 資料模型契約測試（對真實 SQLite 驗證）。
 *
 * 驗收依據：agent/question.md「Repo 管理與權限」與「E+ 方案 — ref 快照」。
 *
 * 測試涵蓋：
 *   - Repo         第 30 行：同擁有者倉庫名唯一、安全預設（private / main / 計數器歸零）
 *   - Collaborator 第 74 行：同倉庫同使用者僅一筆、預設最小權限 read
 *   - RepoRef      第 103 行：同倉庫 ref 名唯一、刪除倉庫級聯清除
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

async function makeUser() {
  return prisma.user.create({ data: { username: uniq('u'), passwordHash: 'hash' } });
}

async function makeRepo(name = uniq('repo'), ownerId?: string) {
  const owner = ownerId ?? (await makeUser()).id;
  return prisma.repo.create({
    data: { ownerId: owner, name, storagePath: `/repos/${owner}/${name}` },
  });
}

describe('Repo 模型', () => {
  it('同一擁有者下倉庫名必須唯一', async () => {
    const owner = await makeUser();
    await makeRepo('same-name', owner.id);
    await expect(makeRepo('same-name', owner.id)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('不同擁有者可使用相同倉庫名', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeRepo('shared-name', a.id);
    await expect(makeRepo('shared-name', b.id)).resolves.toMatchObject({ name: 'shared-name' });
  });

  it('採用安全預設值：私有、main 分支、問題編號計數器歸零', async () => {
    const repo = await makeRepo();
    expect(repo.visibility).toBe('private');
    expect(repo.defaultBranch).toBe('main');
    expect(repo.issueCounter).toBe(0);
    expect(repo.description).toBeNull();
  });

  it('記錄 儲存桶 儲存路徑作為權威資料位置', async () => {
    const repo = await makeRepo();
    expect(repo.storagePath.startsWith('/repos/')).toBe(true);
  });

  it('刪除擁有者時級聯清除其倉庫', async () => {
    const owner = await makeUser();
    const repo = await makeRepo(uniq('r'), owner.id);
    await prisma.user.delete({ where: { id: owner.id } });
    expect(await prisma.repo.findUnique({ where: { id: repo.id } })).toBeNull();
  });
});

describe('Collaborator 模型', () => {
  it('同一倉庫同一使用者僅能有一筆權限', async () => {
    const repo = await makeRepo();
    const user = await makeUser();
    await prisma.collaborator.create({ data: { repoId: repo.id, userId: user.id } });
    await expect(
      prisma.collaborator.create({ data: { repoId: repo.id, userId: user.id, role: 'write' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('預設給予最小權限 read', async () => {
    const repo = await makeRepo();
    const user = await makeUser();
    const collab = await prisma.collaborator.create({
      data: { repoId: repo.id, userId: user.id },
    });
    expect(collab.role).toBe('read');
  });

  it('刪除倉庫時級聯清除協作者', async () => {
    const repo = await makeRepo();
    const user = await makeUser();
    await prisma.collaborator.create({ data: { repoId: repo.id, userId: user.id } });
    await prisma.repo.delete({ where: { id: repo.id } });
    expect(await prisma.collaborator.count({ where: { repoId: repo.id } })).toBe(0);
  });
});

describe('RepoRef 模型', () => {
  it('同一倉庫內 ref 名稱唯一', async () => {
    const repo = await makeRepo();
    await prisma.repoRef.create({
      data: { repoId: repo.id, name: 'refs/heads/main', targetOid: 'a'.repeat(40) },
    });
    await expect(
      prisma.repoRef.create({
        data: { repoId: repo.id, name: 'refs/heads/main', targetOid: 'b'.repeat(40) },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('刪除倉庫時級聯清除 ref', async () => {
    const repo = await makeRepo();
    await prisma.repoRef.create({
      data: { repoId: repo.id, name: 'refs/heads/dev', targetOid: 'c'.repeat(40) },
    });
    await prisma.repo.delete({ where: { id: repo.id } });
    expect(await prisma.repoRef.count({ where: { repoId: repo.id } })).toBe(0);
  });
});
