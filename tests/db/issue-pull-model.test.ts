/**
 * 階段 2 — Issue、Pull Request 與審查資料模型契約測試（對真實 SQLite 驗證）。
 *
 * 驗收依據：agent/question.md「Issues/PR 雙寫」— SQLite 為查詢層、儲存桶 JSON 為真相。
 *
 * 測試涵蓋：
 *   - RepoItemNumber           第 39 行：issue 與 PR 共用同一編號序列，DB 層強制不重號
 *   - Issue                    第 66 行：同倉庫編號唯一、預設 open、記錄 儲存桶 真相路徑
 *   - IssueComment             第 104 行：刪除 issue 級聯清除留言
 *   - PullRequest              第 121 行：同倉庫編號唯一、預設 open、保存 head/base 快照
 *   - PullRequestReview(+留言) 第 163 行：審查與行級留言的級聯清除
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
const oid = (seed: string): string => seed.repeat(40).slice(0, 40);

async function makeRepoAndUser() {
  const user = await prisma.user.create({ data: { username: uniq('u'), passwordHash: 'hash' } });
  const name = uniq('repo');
  const repo = await prisma.repo.create({
    data: { ownerId: user.id, name, storagePath: `/repos/${user.id}/${name}` },
  });
  return { user, repo };
}

describe('RepoItemNumber 共用編號序列', () => {
  it('同一倉庫內 issue 與 PR 不可共用同一編號', async () => {
    const { repo } = await makeRepoAndUser();
    await prisma.repoItemNumber.create({ data: { repoId: repo.id, number: 1, kind: 'issue' } });
    await expect(
      prisma.repoItemNumber.create({ data: { repoId: repo.id, number: 1, kind: 'pull' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('不同倉庫的編號彼此獨立', async () => {
    const a = await makeRepoAndUser();
    const b = await makeRepoAndUser();
    await prisma.repoItemNumber.create({ data: { repoId: a.repo.id, number: 1, kind: 'issue' } });
    await expect(
      prisma.repoItemNumber.create({ data: { repoId: b.repo.id, number: 1, kind: 'issue' } }),
    ).resolves.toMatchObject({ number: 1 });
  });
});

describe('Issue 模型', () => {
  async function makeIssue(number = 1) {
    const { repo, user } = await makeRepoAndUser();
    const issue = await prisma.issue.create({
      data: {
        repoId: repo.id,
        number,
        authorId: user.id,
        title: 'bug',
        storagePath: `${repo.storagePath}/issues/${number}.json`,
      },
    });
    return { repo, user, issue };
  }

  it('同一倉庫內編號唯一', async () => {
    const { repo, user } = await makeRepoAndUser();
    const base = {
      repoId: repo.id,
      number: 7,
      authorId: user.id,
      title: 't',
      storagePath: `${repo.storagePath}/issues/7.json`,
    };
    await prisma.issue.create({ data: base });
    await expect(prisma.issue.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('預設為 open 且尚未關閉，body 預設空字串', async () => {
    const { issue } = await makeIssue();
    expect(issue.state).toBe('open');
    expect(issue.closedAt).toBeNull();
    expect(issue.body).toBe('');
  });

  it('記錄 儲存桶 JSON 真相路徑', async () => {
    const { issue } = await makeIssue(3);
    expect(issue.storagePath.endsWith('/issues/3.json')).toBe(true);
  });
});

describe('IssueComment 模型', () => {
  it('刪除 issue 時級聯清除留言', async () => {
    const { repo, user } = await makeRepoAndUser();
    const issue = await prisma.issue.create({
      data: {
        repoId: repo.id,
        number: 1,
        authorId: user.id,
        title: 't',
        storagePath: `${repo.storagePath}/issues/1.json`,
      },
    });
    await prisma.issueComment.create({
      data: { issueId: issue.id, authorId: user.id, body: 'hi' },
    });
    await prisma.issue.delete({ where: { id: issue.id } });
    expect(await prisma.issueComment.count({ where: { issueId: issue.id } })).toBe(0);
  });
});

describe('PullRequest 模型', () => {
  async function makePull(number = 1) {
    const { repo, user } = await makeRepoAndUser();
    const pull = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number,
        authorId: user.id,
        title: 'feat',
        headRef: 'refs/heads/feature',
        baseRef: 'refs/heads/main',
        headOid: oid('a'),
        baseOid: oid('b'),
        storagePath: `${repo.storagePath}/pulls/${number}.json`,
      },
    });
    return { repo, user, pull };
  }

  it('同一倉庫內編號唯一', async () => {
    const { repo, user } = await makeRepoAndUser();
    const base = {
      repoId: repo.id,
      number: 5,
      authorId: user.id,
      title: 'p',
      headRef: 'refs/heads/f',
      baseRef: 'refs/heads/main',
      headOid: oid('a'),
      baseOid: oid('b'),
      storagePath: `${repo.storagePath}/pulls/5.json`,
    };
    await prisma.pullRequest.create({ data: base });
    await expect(prisma.pullRequest.create({ data: base })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('預設為 open 且未合併，保存 head/base 的 ref 與 oid 快照', async () => {
    const { pull } = await makePull();
    expect(pull.state).toBe('open');
    expect(pull.mergedAt).toBeNull();
    expect(pull.mergedById).toBeNull();
    expect(pull.headOid).toHaveLength(40);
    expect(pull.baseRef).toBe('refs/heads/main');
  });
});

describe('PullRequestReview 與行級留言', () => {
  it('刪除 PR 時級聯清除審查與行級留言', async () => {
    const { repo, user } = await makeRepoAndUser();
    const pull = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number: 1,
        authorId: user.id,
        title: 'p',
        headRef: 'refs/heads/f',
        baseRef: 'refs/heads/main',
        headOid: oid('a'),
        baseOid: oid('b'),
        storagePath: `${repo.storagePath}/pulls/1.json`,
      },
    });
    const review = await prisma.pullRequestReview.create({
      data: { pullRequestId: pull.id, reviewerId: user.id, state: 'approved' },
    });
    await prisma.pullRequestReviewComment.create({
      data: { reviewId: review.id, filePath: 'src/a.ts', line: 10, body: 'nit' },
    });

    await prisma.pullRequest.delete({ where: { id: pull.id } });
    expect(await prisma.pullRequestReview.count({ where: { pullRequestId: pull.id } })).toBe(0);
    expect(await prisma.pullRequestReviewComment.count({ where: { reviewId: review.id } })).toBe(0);
  });

  it('行級留言預設標註在新版（RIGHT）側', async () => {
    const { repo, user } = await makeRepoAndUser();
    const pull = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number: 2,
        authorId: user.id,
        title: 'p',
        headRef: 'refs/heads/f',
        baseRef: 'refs/heads/main',
        headOid: oid('a'),
        baseOid: oid('b'),
        storagePath: `${repo.storagePath}/pulls/2.json`,
      },
    });
    const review = await prisma.pullRequestReview.create({
      data: { pullRequestId: pull.id, reviewerId: user.id, state: 'commented' },
    });
    const comment = await prisma.pullRequestReviewComment.create({
      data: { reviewId: review.id, filePath: 'a.ts', line: 1, body: 'x' },
    });
    expect(comment.side).toBe('RIGHT');
  });
});
