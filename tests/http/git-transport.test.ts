/**
 * Git Smart HTTP 傳輸端點驗收。
 *
 * - info/refs 廣告與服務守門（第 60 行）
 * - Basic auth（帳號 + PAT）認證（第 150 行）
 * - 讀寫權限守門：public/private × 匿名/協作者（第 215 行）
 * - upload-pack 取物件（第 300 行）
 * - receive-pack 推送與 ref 更新（第 360 行）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { parsePktLines } from '@/git/pktline.js';
import { ZERO_OID } from '@/git/protocol.js';
import { scanPack } from '@/git/pack.js';
import { oidOf } from '@/git/object.js';
import { issueAccessToken } from '@/auth/pat.js';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { seedUser, TEST_PASSWORD } from '../helpers/auth.js';
import { buildPack } from '../helpers/pack.js';
const UPLOAD = 'git-upload-pack';
const RECEIVE = 'git-receive-pack';

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function textOf(body: Buffer): string {
  return parsePktLines(body)
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload?.toString('utf8') ?? '')
    .join('');
}

function wantLine(oid: string, caps: string): Buffer {
  const line = `want ${oid} ${caps}\n`;
  const size = (line.length + 4).toString(16).padStart(4, '0');
  return Buffer.from(`${size}${line}0000`, 'utf8');
}

function pushLine(oldOid: string, newOid: string, name: string, pack: Buffer): Buffer {
  const line = `${oldOid} ${newOid} ${name}\0report-status\n`;
  const size = (line.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(`${size}${line}0000`, 'utf8'), pack]);
}

describe('Git Smart HTTP — 廣告與服務守門', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let ownerId = '';

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const owner = await seedUser(prisma, 'git-owner');
    ownerId = owner.id;
    await prisma.repo.create({
      data: {
        name: 'public-repo',
        ownerId,
        visibility: 'public',
        storagePath: '/repos/git-owner/public-repo',
      },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('未指定 service 時回 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/git-owner/public-repo/info/refs' });
    expect(res.statusCode).toBe(404);
  });

  it('拒絕未知 service 名稱', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/git-owner/public-repo/info/refs?service=git-evil-pack',
    });
    expect(res.statusCode).toBe(403);
  });

  it('公開 repo 的 upload-pack 廣告可匿名取得', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('廣告使用 git 規定的 content-type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(res.headers['content-type']).toBe(`application/x-${UPLOAD}-advertisement`);
  });

  it('廣告首行宣告服務名稱', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(textOf(res.rawPayload)).toContain(`# service=${UPLOAD}\n`);
  });

  it('空 repo 廣告零 oid 的能力行', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(textOf(res.rawPayload)).toContain(`${ZERO_OID} capabilities^{}`);
  });

  it('廣告宣告 side-band-64k 能力', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(textOf(res.rawPayload)).toContain('side-band-64k');
  });

  it('不得快取廣告回應', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('已存在的 ref 會出現在廣告中', async () => {
    const repo = await prisma.repo.findFirstOrThrow({ where: { name: 'public-repo' } });
    const oid = 'a'.repeat(40);
    await prisma.repoRef.create({
      data: { repoId: repo.id, name: 'refs/heads/main', targetOid: oid },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${UPLOAD}`,
    });
    expect(textOf(res.rawPayload)).toContain(`${oid} refs/heads/main`);
    await prisma.repoRef.deleteMany({ where: { repoId: repo.id } });
  });

  it('已認證者存取不存在的 repo 回 404', async () => {
    // 匿名者一律得到 401，否則 401/404 的差異本身就會洩漏 repo 是否存在。
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/no-such-repo/info/refs?service=${UPLOAD}`,
      headers: { authorization: basic('git-owner', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('匿名者存取不存在的 repo 回 401 而非 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/no-such-repo/info/refs?service=${UPLOAD}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('公開 repo 的 receive-pack 廣告仍需認證', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${RECEIVE}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('要求認證時附帶 WWW-Authenticate 讓 git 提示輸入憑證', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/git-owner/public-repo/info/refs?service=${RECEIVE}`,
    });
    expect(res.headers['www-authenticate']).toContain('Basic');
  });
});

describe('Git Smart HTTP — Basic auth 認證', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let patToken = '';

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const owner = await seedUser(prisma, 'auth-owner');
    await prisma.repo.create({
      data: {
        name: 'priv',
        ownerId: owner.id,
        visibility: 'private',
        storagePath: '/repos/auth-owner/priv',
      },
    });
    const issued = await issueAccessToken(prisma, { userId: owner.id, name: 'git-cli' });
    patToken = issued.token;
  });

  afterAll(async () => {
    await ctx.close();
  });

  const url = `/auth-owner/priv/info/refs?service=${UPLOAD}`;

  it('以 PAT 當密碼可通過認證', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic('auth-owner', patToken) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('以帳號密碼亦可通過認證', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic('auth-owner', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('錯誤密碼回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic('auth-owner', 'wrong-password') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('PAT 與使用者不相符時回 401', async () => {
    const other = await seedUser(prisma, 'auth-other');
    const issued = await issueAccessToken(prisma, { userId: other.id, name: 'mine' });
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic('auth-owner', issued.token) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('已撤銷的 PAT 回 401', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'auth-owner' } });
    const issued = await issueAccessToken(prisma, { userId: owner.id, name: 'to-revoke' });
    await prisma.personalAccessToken.updateMany({
      where: { userId: owner.id, name: 'to-revoke' },
      data: { revokedAt: new Date() },
    });
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: basic('auth-owner', issued.token) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('畸形的 Basic 標頭回 401 而不拋錯', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Basic not-base64!!' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('私有 repo 匿名存取回 401 而非 404，避免洩漏存在性差異', async () => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });
});

describe('Git Smart HTTP — 權限守門', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const owner = await seedUser(prisma, 'acl-owner');
    const reader = await seedUser(prisma, 'acl-reader');
    const stranger = await seedUser(prisma, 'acl-stranger');
    const repo = await prisma.repo.create({
      data: {
        name: 'secret',
        ownerId: owner.id,
        visibility: 'private',
        storagePath: '/repos/acl-owner/secret',
      },
    });
    await prisma.collaborator.create({
      data: { repoId: repo.id, userId: reader.id, role: 'read' },
    });
    void stranger;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('read 協作者可讀取廣告', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/acl-owner/secret/info/refs?service=${UPLOAD}`,
      headers: { authorization: basic('acl-reader', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('read 協作者不得推送', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/acl-owner/secret/info/refs?service=${RECEIVE}`,
      headers: { authorization: basic('acl-reader', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('非協作者讀取私有 repo 回 404 以隱藏存在性', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/acl-owner/secret/info/refs?service=${UPLOAD}`,
      headers: { authorization: basic('acl-stranger', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('擁有者可取得 receive-pack 廣告', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/acl-owner/secret/info/refs?service=${RECEIVE}`,
      headers: { authorization: basic('acl-owner', TEST_PASSWORD) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('receive-pack 廣告宣告 report-status 能力', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/acl-owner/secret/info/refs?service=${RECEIVE}`,
      headers: { authorization: basic('acl-owner', TEST_PASSWORD) },
    });
    expect(textOf(res.rawPayload)).toContain('report-status');
  });

  it('無寫入權限者 POST git-receive-pack 回 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/acl-owner/secret/git-receive-pack',
      headers: {
        authorization: basic('acl-reader', TEST_PASSWORD),
        'content-type': `application/x-${RECEIVE}-request`,
      },
      payload: Buffer.from('0000', 'utf8'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Git Smart HTTP — upload-pack 與 receive-pack', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let repoId = '';
  const auth = { authorization: basic('xfer-owner', TEST_PASSWORD) };

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const owner = await seedUser(prisma, 'xfer-owner');
    const repo = await prisma.repo.create({
      data: {
        name: 'transfer',
        ownerId: owner.id,
        visibility: 'private',
        storagePath: '/repos/xfer-owner/transfer',
      },
    });
    repoId = repo.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function pushBlob(content: string, refName: string): Promise<string> {
    const { pack } = buildPack([{ type: 'blob', content: Buffer.from(content, 'utf8') }]);
    const oid = oidOf('blob', Buffer.from(content, 'utf8'));
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-receive-pack',
      headers: { ...auth, 'content-type': `application/x-${RECEIVE}-request` },
      payload: pushLine(ZERO_OID, oid, refName, pack),
    });
    expect(res.statusCode).toBe(200);
    return oid;
  }

  it('推送回報 unpack ok 與 ref 接受', async () => {
    const { pack } = buildPack([{ type: 'blob', content: Buffer.from('push-one', 'utf8') }]);
    const oid = oidOf('blob', Buffer.from('push-one', 'utf8'));
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-receive-pack',
      headers: { ...auth, 'content-type': `application/x-${RECEIVE}-request` },
      payload: pushLine(ZERO_OID, oid, 'refs/heads/first', pack),
    });
    const text = textOf(res.rawPayload);
    expect(text).toContain('unpack ok');
    expect(text).toContain('ok refs/heads/first');
  });

  it('推送後 ref 寫入資料庫', async () => {
    const oid = await pushBlob('push-two', 'refs/heads/second');
    const ref = await prisma.repoRef.findFirstOrThrow({
      where: { repoId, name: 'refs/heads/second' },
    });
    expect(ref.targetOid).toBe(oid);
  });

  it('推送後 packfile 與索引寫入儲存桶', async () => {
    await pushBlob('push-three', 'refs/heads/third');
    const paths = [...(ctx.store as unknown as { files: Map<string, Buffer> }).files.keys()];
    expect(paths.some((path) => path.endsWith('.pack'))).toBe(true);
    expect(paths.some((path) => path.endsWith('.idx.json'))).toBe(true);
  });

  it('推送後 SQLite 索引可查到物件', async () => {
    const oid = await pushBlob('push-four', 'refs/heads/fourth');
    const row = await prisma.gitObjectIndex.findFirst({ where: { repoId, oid } });
    expect(row?.objectType).toBe('blob');
  });

  it('刪除 ref 的推送會移除該 ref', async () => {
    const oid = await pushBlob('push-five', 'refs/heads/fifth');
    const { pack } = buildPack([]);
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-receive-pack',
      headers: { ...auth, 'content-type': `application/x-${RECEIVE}-request` },
      payload: pushLine(oid, ZERO_OID, 'refs/heads/fifth', pack),
    });
    expect(textOf(res.rawPayload)).toContain('ok refs/heads/fifth');
    const ref = await prisma.repoRef.findFirst({ where: { repoId, name: 'refs/heads/fifth' } });
    expect(ref).toBeNull();
  });

  it('舊 oid 不符時拒絕該 ref 並回 ng', async () => {
    await pushBlob('push-six', 'refs/heads/sixth');
    const { pack } = buildPack([]);
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-receive-pack',
      headers: { ...auth, 'content-type': `application/x-${RECEIVE}-request` },
      payload: pushLine('b'.repeat(40), 'c'.repeat(40), 'refs/heads/sixth', pack),
    });
    expect(textOf(res.rawPayload)).toContain('ng refs/heads/sixth');
  });

  it('upload-pack 回傳可解析的 packfile', async () => {
    const oid = await pushBlob('fetch-one', 'refs/heads/fetch1');
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-upload-pack',
      headers: { ...auth, 'content-type': `application/x-${UPLOAD}-request` },
      payload: Buffer.concat([wantLine(oid, 'ofs-delta'), Buffer.from('0009done\n', 'utf8')]),
    });
    expect(res.statusCode).toBe(200);
    // 未啟用 side-band 時，NAK 之後直接接裸 packfile，故只解析首個封包。
    expect(res.rawPayload.subarray(0, 8).toString('utf8')).toBe('0008NAK\n');
    expect(scanPack(res.rawPayload.subarray(8)).objectCount).toBe(1);
  });

  it('upload-pack 使用 git 規定的 content-type', async () => {
    const oid = await pushBlob('fetch-two', 'refs/heads/fetch2');
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-upload-pack',
      headers: { ...auth, 'content-type': `application/x-${UPLOAD}-request` },
      payload: Buffer.concat([wantLine(oid, 'ofs-delta'), Buffer.from('0009done\n', 'utf8')]),
    });
    expect(res.headers['content-type']).toBe(`application/x-${UPLOAD}-result`);
  });

  it('啟用 side-band-64k 時 pack 包在頻道 1', async () => {
    const oid = await pushBlob('fetch-three', 'refs/heads/fetch3');
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-upload-pack',
      headers: { ...auth, 'content-type': `application/x-${UPLOAD}-request` },
      payload: Buffer.concat([
        wantLine(oid, 'side-band-64k ofs-delta'),
        Buffer.from('0009done\n', 'utf8'),
      ]),
    });
    const packets = parsePktLines(res.rawPayload);
    expect(packets[1]?.payload?.[0]).toBe(1);
  });

  it('未送出 want 時回空的 NAK 回應', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-upload-pack',
      headers: { ...auth, 'content-type': `application/x-${UPLOAD}-request` },
      payload: Buffer.from('0000', 'utf8'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 8).toString('utf8')).toBe('0008NAK\n');
  });

  it('要求不存在的 oid 不致使請求失敗', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/xfer-owner/transfer/git-upload-pack',
      headers: { ...auth, 'content-type': `application/x-${UPLOAD}-request` },
      payload: Buffer.concat([
        wantLine('d'.repeat(40), 'ofs-delta'),
        Buffer.from('0009done\n', 'utf8'),
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(scanPack(res.rawPayload.subarray(8)).objectCount).toBe(0);
  });
});

describe('Git Smart HTTP — 授權並行', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await createTestApp({ registrationMode: 'closed' });
    app = ctx.app;
    prisma = ctx.prisma;
    const owner = await seedUser(prisma, 'gate-owner');
    await prisma.repo.create({
      data: {
        name: 'gate-repo',
        ownerId: owner.id,
        visibility: 'private',
        storagePath: '/repos/gate-owner/gate-repo',
      },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('認證查詢與 repo 查詢並行發出', async () => {
    const userFind = prisma.user.findUnique.bind(prisma.user);
    const repoFind = prisma.repo.findFirst.bind(prisma.repo);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authCalls = 0;
    let repoCalls = 0;

    const userSpy = vi.spyOn(prisma.user, 'findUnique').mockImplementation(
      (async (...args: Parameters<typeof userFind>) => {
        authCalls += 1;
        await gate;
        return userFind(...args);
      }) as unknown as typeof prisma.user.findUnique,
    );
    const repoSpy = vi.spyOn(prisma.repo, 'findFirst').mockImplementation(
      (async (...args: Parameters<typeof repoFind>) => {
        repoCalls += 1;
        await gate;
        return repoFind(...args);
      }) as unknown as typeof prisma.repo.findFirst,
    );

    try {
      const pending = app.inject({
        method: 'GET',
        url: '/gate-owner/gate-repo/info/refs?service=git-upload-pack',
        headers: { authorization: basic('gate-owner', TEST_PASSWORD) },
      });
      // 序列實作下，repo.findFirst 要等認證（含 argon2）完成才會發出 → 此處超時。
      await vi.waitFor(() => {
        if (authCalls < 1 || repoCalls < 1) {
          throw new Error(`auth=${authCalls} repo=${repoCalls}`);
        }
      });
      release?.();
      const res = await pending;
      expect(res.statusCode).toBe(200);
    } finally {
      userSpy.mockRestore();
      repoSpy.mockRestore();
    }
  });
});
