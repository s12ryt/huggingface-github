/**
 * 階段 10 驗收：Repo CRUD HTTP 端點。
 *
 * - 建立 repo：名稱守門、擁有者唯一、儲存桶 路徑配置、可見性
 * - 列表與取得：私有 repo 對無權者隱藏存在性
 * - 協作者管理：僅擁有者或站台管理員可增刪，角色白名單
 * - 刪除 repo：僅擁有者或站台管理員
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { loginCookie, seedUser, type SeededUser } from '../helpers/auth.js';

let ctx: TestApp;
let owner: SeededUser;
let other: SeededUser;
let siteAdmin: SeededUser;
let ownerCookie: string;
let otherCookie: string;
let adminCookie: string;

beforeAll(async () => {
  ctx = await createTestApp({ registrationMode: 'closed' });
  owner = await seedUser(ctx.prisma, 'repo-owner');
  other = await seedUser(ctx.prisma, 'repo-other');
  siteAdmin = await seedUser(ctx.prisma, 'repo-admin', 'admin');
  ownerCookie = await loginCookie(ctx.app, owner.username);
  otherCookie = await loginCookie(ctx.app, other.username);
  adminCookie = await loginCookie(ctx.app, siteAdmin.username);
});

afterAll(async () => {
  await ctx.close();
});

async function create(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/repos',
    cookies: { odg_session: cookie.replace('odg_session=', '') },
    payload,
  });
  return res as LightMyRequestResponse;
}

describe('建立 repo', () => {
  it('未登入者不得建立', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/repos', payload: { name: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('建立成功回 201 與 repo 摘要', async () => {
    const res = await create(ownerCookie, { name: 'first-repo' });
    expect(res.statusCode).toBe(201);
    expect(res.json().repo).toMatchObject({
      defaultBranch: 'main',
      name: 'first-repo',
      owner: 'repo-owner',
      visibility: 'private',
    });
  });

  it('預設為私有以避免誤公開', async () => {
    const res = await create(ownerCookie, { name: 'default-private' });
    expect(res.json().repo.visibility).toBe('private');
  });

  it('可指定為公開', async () => {
    const res = await create(ownerCookie, { name: 'public-one', visibility: 'public' });
    expect(res.statusCode).toBe(201);
    expect(res.json().repo.visibility).toBe('public');
  });

  it('非法可見性回 400', async () => {
    const res = await create(ownerCookie, { name: 'bad-vis', visibility: 'secret' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_visibility');
  });

  it('儲存桶 路徑依擁有者與名稱配置', async () => {
    await create(ownerCookie, { name: 'path-check' });
    const row = await ctx.prisma.repo.findFirst({ where: { name: 'path-check' } });
    expect(row?.storagePath).toBe('/repos/repo-owner/path-check');
  });

  it('同一擁有者不得重名', async () => {
    await create(ownerCookie, { name: 'dup-repo' });
    const res = await create(ownerCookie, { name: 'dup-repo' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('repo_exists');
  });

  it('不同擁有者可以同名', async () => {
    await create(ownerCookie, { name: 'shared-name' });
    const res = await create(otherCookie, { name: 'shared-name' });
    expect(res.statusCode).toBe(201);
  });

  it.each(['ab', 'has space', '-lead', 'trail-', 'bad$char', '.git', 'a'.repeat(101)])(
    '拒絕非法名稱 %s',
    async (name) => {
      const res = await create(ownerCookie, { name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_repo_name');
    },
  );

  it('缺少名稱回 400', async () => {
    const res = await create(ownerCookie, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_repo_name');
  });

  it('描述可選且被保存', async () => {
    const res = await create(ownerCookie, { description: '我的專案', name: 'with-desc' });
    expect(res.json().repo.description).toBe('我的專案');
  });
});

describe('列表與取得', () => {
  it('列表只回自己擁有與協作的 repo', async () => {
    await create(otherCookie, { name: 'others-private' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().repos.map((r: { name: string }) => r.name);
    expect(names).not.toContain('others-private');
    expect(names).toContain('first-repo');
  });

  it('未登入者列表回 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/repos' });
    expect(res.statusCode).toBe(401);
  });

  it('匿名者可取得公開 repo', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/repos/repo-owner/public-one' });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.name).toBe('public-one');
  });

  it('匿名者取得私有 repo 回 404 以隱藏存在性', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/repos/repo-owner/first-repo' });
    expect(res.statusCode).toBe(404);
  });

  it('無權的已登入者取得私有 repo 也回 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/first-repo',
      cookies: { odg_session: otherCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(404);
  });

  it('擁有者可取得自己的私有 repo', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/first-repo',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.visibility).toBe('private');
  });

  it('站台管理員可取得任何私有 repo', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/first-repo',
      cookies: { odg_session: adminCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(200);
  });

  it('不存在的 repo 回 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/ghost-repo',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(404);
  });

  it('取得的回應附帶 git clone 位址', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/repos/repo-owner/public-one' });
    expect(res.json().repo.cloneUrl).toContain('/repo-owner/public-one.git');
  });
});

describe('協作者管理', () => {
  it('擁有者可新增協作者', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-other',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: { role: 'write' },
    });
    expect(res.statusCode).toBe(204);
    const row = await ctx.prisma.collaborator.findFirst({ where: { userId: other.id } });
    expect(row?.role).toBe('write');
  });

  it('新增後該協作者即可讀取該 repo', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/first-repo',
      cookies: { odg_session: otherCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(200);
  });

  it('重複新增視為更新角色', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-other',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: { role: 'read' },
    });
    expect(res.statusCode).toBe(204);
    const row = await ctx.prisma.collaborator.findFirst({ where: { userId: other.id } });
    expect(row?.role).toBe('read');
  });

  it('未指定角色時預設 read', async () => {
    await create(ownerCookie, { name: 'role-default' });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/role-default/collaborators/repo-other',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    const repo = await ctx.prisma.repo.findFirst({ where: { name: 'role-default' } });
    const row = await ctx.prisma.collaborator.findFirst({
      where: { repoId: repo?.id ?? '', userId: other.id },
    });
    expect(row?.role).toBe('read');
  });

  it('非法角色回 400', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-other',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_role');
  });

  it('不存在的使用者回 404', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/nobody-here',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: { role: 'read' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('擁有者不得把自己加為協作者', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-owner',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
      payload: { role: 'write' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('owner_is_not_collaborator');
  });

  it('協作者本人不得新增其他協作者', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-admin',
      cookies: { odg_session: otherCookie.replace('odg_session=', '') },
      payload: { role: 'write' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('站台管理員可新增協作者', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-admin',
      cookies: { odg_session: adminCookie.replace('odg_session=', '') },
      payload: { role: 'read' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('列表回傳協作者與角色', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/repos/repo-owner/first-repo/collaborators',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().collaborators.find((c: { username: string }) => c.username === 'repo-other');
    expect(found.role).toBe('read');
  });

  it('擁有者可移除協作者', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-admin',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(204);
  });

  it('移除不存在的協作關係回 404', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/first-repo/collaborators/repo-admin',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('刪除 repo', () => {
  it('擁有者可刪除', async () => {
    await create(ownerCookie, { name: 'to-delete' });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/to-delete',
      cookies: { odg_session: ownerCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.prisma.repo.findFirst({ where: { name: 'to-delete' } })).toBeNull();
  });

  it('非擁有者刪除回 404（私有 repo 隱藏存在性）', async () => {
    await create(ownerCookie, { name: 'keep-mine' });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/keep-mine',
      cookies: { odg_session: otherCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(404);
    expect(await ctx.prisma.repo.findFirst({ where: { name: 'keep-mine' } })).not.toBeNull();
  });

  it('寫權協作者不得刪除 repo', async () => {
    await create(ownerCookie, { name: 'writer-cannot-delete' });
    const repo = await ctx.prisma.repo.findFirst({ where: { name: 'writer-cannot-delete' } });
    await ctx.prisma.collaborator.create({
      data: { repoId: repo?.id ?? '', role: 'write', userId: other.id },
    });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/writer-cannot-delete',
      cookies: { odg_session: otherCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.prisma.repo.findFirst({ where: { name: 'writer-cannot-delete' } })).not.toBeNull();
  });

  it('站台管理員可刪除任何 repo', async () => {
    await create(ownerCookie, { name: 'admin-can-delete' });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/repos/repo-owner/admin-can-delete',
      cookies: { odg_session: adminCookie.replace('odg_session=', '') },
    });
    expect(res.statusCode).toBe(204);
  });
});
