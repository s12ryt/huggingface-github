/**
 * Issues 服務層 — SQLite 查詢層 + 儲存桶 JSON 權威副本雙寫
 *
 * 1. createIssue：取號、寫 DB、寫 儲存桶 JSON
 * 2. addIssueComment：留言雙寫
 * 3. setIssueState：開啟 / 關閉並同步 JSON
 * 4. listIssues：依編號遞減列出，可依狀態篩選
 * 5. rebuildIssuesFromStore：由 儲存桶 權威副本重建 SQLite（幂等）
 */
import type { PrismaClient } from '@prisma/client';

import {
  issueJsonPath,
  loadIssueDocument,
  type IssueDocument,
  type IssueStoreIo,
} from './document.js';
import { nextItemNumber } from './numbering.js';

export { issueJsonPath, loadIssueDocument } from './document.js';
export type { IssueDocument, IssueCommentDocument } from './document.js';
export { nextItemNumber } from './numbering.js';
export type { ItemKind } from './numbering.js';

export const ISSUE_STATES = ['open', 'closed'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export class IssueError extends Error {
  constructor(reason: string) {
    super(`Issue rejected: ${reason}`);
    this.name = 'IssueError';
  }
}

export interface IssueSummary {
  author: string;
  body: string;
  closedAt: Date | null;
  id: string;
  number: number;
  state: string;
  title: string;
}

export interface CreateIssueInput {
  authorId: string;
  body?: string;
  repoId: string;
  repoPath: string;
  title: string;
}

export interface AddCommentInput {
  authorId: string;
  body: string;
  issueId: string;
  repoPath: string;
}

export interface SetStateInput {
  issueId: string;
  repoPath: string;
  state: IssueState;
}

const SUMMARY_SELECT = {
  author: { select: { username: true } },
  body: true,
  closedAt: true,
  id: true,
  number: true,
  state: true,
  title: true,
} as const;

type SummaryRow = {
  author: { username: string };
  body: string;
  closedAt: Date | null;
  id: string;
  number: number;
  state: string;
  title: string;
};

function toSummary(row: SummaryRow): IssueSummary {
  return { ...row, author: row.author.username };
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new IssueError(`${field} must not be blank`);
  return text;
}

/** 由 DB 現況重新產生權威副本，確保 JSON 永遠是完整快照而非增量。 */
async function syncDocument(
  prisma: PrismaClient,
  store: IssueStoreIo,
  repoPath: string,
  issueId: string,
): Promise<void> {
  const row = await prisma.issue.findUnique({
    include: {
      author: { select: { username: true } },
      comments: {
        include: { author: { select: { username: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
    where: { id: issueId },
  });
  if (!row) throw new IssueError('issue not found');

  const doc: IssueDocument = {
    author: row.author.username,
    body: row.body,
    closedAt: row.closedAt?.toISOString() ?? null,
    comments: row.comments.map((comment) => ({
      author: comment.author.username,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    number: row.number,
    state: row.state,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
  await store.putJson(issueJsonPath(repoPath, row.number), doc);
}

export async function createIssue(
  prisma: PrismaClient,
  store: IssueStoreIo,
  input: CreateIssueInput,
): Promise<IssueSummary> {
  const title = requireText(input.title, 'title');
  const number = await nextItemNumber(prisma, input.repoId, 'issue');
  const row = await prisma.issue.create({
    data: {
      authorId: input.authorId,
      body: input.body ?? '',
      number,
      storagePath: issueJsonPath(input.repoPath, number),
      repoId: input.repoId,
      title,
    },
    select: SUMMARY_SELECT,
  });
  await syncDocument(prisma, store, input.repoPath, row.id);
  return toSummary(row);
}

export async function addIssueComment(
  prisma: PrismaClient,
  store: IssueStoreIo,
  input: AddCommentInput,
): Promise<void> {
  const body = requireText(input.body, 'body');
  const issue = await prisma.issue.findUnique({
    select: { id: true },
    where: { id: input.issueId },
  });
  if (!issue) throw new IssueError('issue not found');

  await prisma.issueComment.create({
    data: { authorId: input.authorId, body, issueId: input.issueId },
  });
  await syncDocument(prisma, store, input.repoPath, input.issueId);
}

export async function setIssueState(
  prisma: PrismaClient,
  store: IssueStoreIo,
  input: SetStateInput,
): Promise<IssueSummary> {
  if (!ISSUE_STATES.includes(input.state)) {
    throw new IssueError(`state must be one of ${ISSUE_STATES.join(', ')}`);
  }
  const row = await prisma.issue.update({
    data: { closedAt: input.state === 'closed' ? new Date() : null, state: input.state },
    select: SUMMARY_SELECT,
    where: { id: input.issueId },
  });
  await syncDocument(prisma, store, input.repoPath, row.id);
  return toSummary(row);
}

export async function listIssues(
  prisma: PrismaClient,
  repoId: string,
  state?: IssueState,
): Promise<IssueSummary[]> {
  const rows = await prisma.issue.findMany({
    orderBy: { number: 'desc' },
    select: SUMMARY_SELECT,
    where: state ? { repoId, state } : { repoId },
  });
  return rows.map(toSummary);
}

export interface RebuildInput {
  numbers: number[];
  repoId: string;
  repoPath: string;
}

/**
 * 以 儲存桶 JSON 為真相重建查詢層。作者以用戶名回查，找不到則退回 repo 擁有者，
 * 這讓資料庫能在使用者被刪除後仍完整重建。
 */
export async function rebuildIssuesFromStore(
  prisma: PrismaClient,
  store: IssueStoreIo,
  input: RebuildInput,
): Promise<number> {
  const repo = await prisma.repo.findUnique({
    select: { ownerId: true },
    where: { id: input.repoId },
  });
  if (!repo) return 0;

  let restored = 0;
  // 同一使用者名稱在整份重建中只回查一次資料庫。
  const authorCache = new Map<string, string>();
  const resolveAuthor = async (username: string): Promise<string> => {
    const cached = authorCache.get(username);
    if (cached) return cached;
    const user = await prisma.user.findUnique({ select: { id: true }, where: { username } });
    const id = user?.id ?? repo.ownerId;
    authorCache.set(username, id);
    return id;
  };
  for (const number of input.numbers) {
    const doc = await loadIssueDocument(store, input.repoPath, number);
    if (!doc) continue;

    const authorId = await resolveAuthor(doc.author);
    const issue = await prisma.issue.upsert({
      create: {
        authorId,
        body: doc.body,
        closedAt: doc.closedAt ? new Date(doc.closedAt) : null,
        number: doc.number,
        storagePath: issueJsonPath(input.repoPath, doc.number),
        repoId: input.repoId,
        state: doc.state,
        title: doc.title,
      },
      select: { id: true },
      update: {
        body: doc.body,
        closedAt: doc.closedAt ? new Date(doc.closedAt) : null,
        state: doc.state,
        title: doc.title,
      },
      where: { repoId_number: { number: doc.number, repoId: input.repoId } },
    });

    await prisma.issueComment.deleteMany({ where: { issueId: issue.id } });
    for (const comment of doc.comments) {
      await prisma.issueComment.create({
        data: {
          authorId: await resolveAuthor(comment.author),
          body: comment.body,
          createdAt: new Date(comment.createdAt),
          issueId: issue.id,
        },
      });
    }
    restored += 1;
  }
  return restored;
}
