/**
 * Repo 權限判定測試：public/private 可見性、collaborator 角色、擁有者與管理員。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  COLLABORATOR_ROLES,
  canRead,
  canWrite,
  isCollaboratorRole,
  resolveAccess,
} from '@/repos/access.js';

let db: TestDb;
let prisma: PrismaClient;
let ownerId = '';
let adminId = '';
let readerId = '';
let writerId = '';
let strangerId = '';
let publicRepoId = '';
let privateRepoId = '';

beforeAll(async () => {
  db = createTestDb();
  prisma = db.prisma;

  const make = async (username: string, role = 'user') =>
    (await prisma.user.create({ data: { passwordHash: '$argon2id$stub', role, username } })).id;

  ownerId = await make('acc-owner');
  adminId = await make('acc-admin', 'admin');
  readerId = await make('acc-reader');
  writerId = await make('acc-writer');
  strangerId = await make('acc-stranger');

  publicRepoId = (
    await prisma.repo.create({
      data: {
        name: 'open-repo',
        storagePath: '/repos/acc-owner/open-repo',
        ownerId,
        visibility: 'public',
      },
    })
  ).id;

  privateRepoId = (
    await prisma.repo.create({
      data: { name: 'shut-repo', storagePath: '/repos/acc-owner/shut-repo', ownerId },
    })
  ).id;

  await prisma.collaborator.create({
    data: { repoId: privateRepoId, role: 'read', userId: readerId },
  });
  await prisma.collaborator.create({
    data: { repoId: privateRepoId, role: 'write', userId: writerId },
  });
});

afterAll(async () => {
  await db.close();
});

describe('角色常數', () => {
  it('恰好三種協作者角色', () => {
    expect([...COLLABORATOR_ROLES]).toEqual(['read', 'write', 'admin']);
  });

  it.each(['read', 'write', 'admin'])('接受合法角色 %s', (role) => {
    expect(isCollaboratorRole(role)).toBe(true);
  });

  it.each(['owner', 'READ', '', 'maintainer'])('拒絕非法角色 %s', (role) => {
    expect(isCollaboratorRole(role)).toBe(false);
  });
});

describe('公開 repo', () => {
  it('匿名可讀', async () => {
    expect(canRead(await resolveAccess(prisma, publicRepoId, null))).toBe(true);
  });

  it('匿名不可寫', async () => {
    expect(canWrite(await resolveAccess(prisma, publicRepoId, null))).toBe(false);
  });

  it('非協作者的登入使用者可讀但不可寫', async () => {
    const access = await resolveAccess(prisma, publicRepoId, { id: strangerId, role: 'user' });
    expect(canRead(access)).toBe(true);
    expect(canWrite(access)).toBe(false);
  });

  it('擁有者可寫', async () => {
    const access = await resolveAccess(prisma, publicRepoId, { id: ownerId, role: 'user' });
    expect(canWrite(access)).toBe(true);
    expect(access.isOwner).toBe(true);
  });
});

describe('私有 repo', () => {
  it('匿名不可讀', async () => {
    expect(canRead(await resolveAccess(prisma, privateRepoId, null))).toBe(false);
  });

  it('非協作者不可讀', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: strangerId, role: 'user' });
    expect(canRead(access)).toBe(false);
  });

  it('read 協作者可讀不可寫', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: readerId, role: 'user' });
    expect(canRead(access)).toBe(true);
    expect(canWrite(access)).toBe(false);
  });

  it('write 協作者可讀可寫', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: writerId, role: 'user' });
    expect(canWrite(access)).toBe(true);
  });

  it('擁有者可讀可寫', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: ownerId, role: 'user' });
    expect(canWrite(access)).toBe(true);
  });

  it('站台管理員可讀可寫', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: adminId, role: 'admin' });
    expect(canWrite(access)).toBe(true);
    expect(access.isSiteAdmin).toBe(true);
  });

  it('回報協作者角色供 UI 顯示', async () => {
    const access = await resolveAccess(prisma, privateRepoId, { id: writerId, role: 'user' });
    expect(access.role).toBe('write');
  });
});

describe('不存在的 repo', () => {
  it('回報 exists 為 false 且不可讀寫', async () => {
    const access = await resolveAccess(prisma, 'no-such-repo', { id: ownerId, role: 'user' });
    expect(access.exists).toBe(false);
    expect(canRead(access)).toBe(false);
    expect(canWrite(access)).toBe(false);
  });

  it('站台管理員對不存在的 repo 也不可寫', async () => {
    const access = await resolveAccess(prisma, 'no-such-repo', { id: adminId, role: 'admin' });
    expect(canWrite(access)).toBe(false);
  });
});

describe('並行查詢', () => {
  it('repo 查詢與 collaborator 查詢並行發出', async () => {
    const repoFind = prisma.repo.findUnique.bind(prisma.repo);
    const collabFind = prisma.collaborator.findUnique.bind(prisma.collaborator);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let repoCalls = 0;
    let collabCalls = 0;

    const repoSpy = vi.spyOn(prisma.repo, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof repoFind>) => {
        repoCalls += 1;
        await gate;
        return repoFind(...args);
      }) as unknown as typeof prisma.repo.findUnique,
    );
    const collabSpy = vi.spyOn(prisma.collaborator, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof collabFind>) => {
        collabCalls += 1;
        await gate;
        return collabFind(...args);
      }) as unknown as typeof prisma.collaborator.findUnique,
    );

    try {
      const pending = resolveAccess(prisma, privateRepoId, { id: readerId, role: 'user' });
      await vi.waitFor(() => {
        if (repoCalls < 1 || collabCalls < 1) {
          throw new Error(`repo=${repoCalls} collab=${collabCalls}`);
        }
      });
      release?.();
      const access = await pending;
      expect(access.role).toBe('read');
    } finally {
      repoSpy.mockRestore();
      collabSpy.mockRestore();
    }
  });
});
