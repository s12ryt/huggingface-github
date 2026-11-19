/**
 * Pull Request 服務層 — SQLite 查詢層 + 儲存桶 JSON 權威副本雙寫
 *
 * 1. createPullRequest：與 issue 共用編號序列、雙寫
 * 2. addReview：審查與行級留言
 * 3. mergePullRequest / setPullState：合併與開關，合併為終局狀態
 * 4. listPullRequests：依編號遞減，可依狀態篩選
 * 5. 轉出 diffTrees 供路由層計算變更檔案
 */
import type { PrismaClient } from '@prisma/client';

import { nextItemNumber } from '../issues/numbering.js';
import { pullJsonPath, type PullDocument, type PullStoreIo } from './document.js';

export { loadPullDocument, pullJsonPath } from './document.js';
export type { PullDocument, PullReviewDocument } from './document.js';
export { diffTrees } from './diff.js';
export type { DiffEntry, DiffStatus } from './diff.js';

export const PULL_STATES = ['open', 'closed', 'merged'] as const;
export type PullState = (typeof PULL_STATES)[number];

export const REVIEW_STATES = ['approved', 'changes_requested', 'commented'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_SIDES = ['LEFT', 'RIGHT'] as const;
export type ReviewSide = (typeof REVIEW_SIDES)[number];

const OID_PATTERN = /^[0-9a-f]{40}$/;

export class PullError extends Error {
  constructor(reason: string) {
    super(`Pull request rejected: ${reason}`);
    this.name = 'PullError';
  }
}

export interface PullSummary {
  author: string;
  baseOid: string;
  baseRef: string;
  body: string;
  headOid: string;
  headRef: string;
  id: string;
  mergedAt: Date | null;
  mergedBy: string | null;
  number: number;
  state: string;
  title: string;
}

export interface CreatePullInput {
  authorId: string;
  baseOid: string;
  baseRef: string;
  body?: string;
  headOid: string;
  headRef: string;
  repoId: string;
  repoPath: string;
  title: string;
}

export interface ReviewCommentInput {
  body: string;
  filePath: string;
  line: number;
  side?: ReviewSide;
}

export interface AddReviewInput {
  body: string;
  comments: ReviewCommentInput[];
  pullRequestId: string;
  repoPath: string;
  reviewerId: string;
  state: ReviewState;
}

export interface MergeInput {
  mergedById: string;
  pullRequestId: string;
  repoPath: string;
}

export interface SetPullStateInput {
  pullRequestId: string;
  repoPath: string;
  state: 'open' | 'closed';
}

const SUMMARY_SELECT = {
  author: { select: { username: true } },
  baseOid: true,
  baseRef: true,
  body: true,
  headOid: true,
  headRef: true,
  id: true,
  mergedAt: true,
  mergedBy: { select: { username: true } },
  number: true,
  state: true,
  title: true,
} as const;

type SummaryRow = {
  author: { username: string };
  baseOid: string;
  baseRef: string;
  body: string;
  headOid: string;
  headRef: string;
  id: string;
  mergedAt: Date | null;
  mergedBy: { username: string } | null;
  number: number;
  state: string;
  title: string;
};

function toSummary(row: SummaryRow): PullSummary {
  return {
    ...row,
    author: row.author.username,
    mergedBy: row.mergedBy?.username ?? null,
  };
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PullError(`${field} must not be blank`);
  return text;
}

function requireOid(value: string, field: string): string {
  const oid = value.toLowerCase();
  if (!OID_PATTERN.test(oid)) throw new PullError(`${field} is not a valid oid`);
  return oid;
}

/** 由 DB 現況重新產生權威副本，確保 JSON 永遠是完整快照。 */
async function syncDocument(
  prisma: PrismaClient,
  store: PullStoreIo,
  repoPath: string,
  pullRequestId: string,
): Promise<void> {
  const row = await prisma.pullRequest.findUnique({
    include: {
      author: { select: { username: true } },
      mergedBy: { select: { username: true } },
      reviews: {
        include: {
          comments: { orderBy: { createdAt: 'asc' } },
          reviewer: { select: { username: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    where: { id: pullRequestId },
  });
  if (!row) throw new PullError('pull request not found');

  const doc: PullDocument = {
    author: row.author.username,
    baseOid: row.baseOid,
    baseRef: row.baseRef,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    headOid: row.headOid,
    headRef: row.headRef,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    mergedBy: row.mergedBy?.username ?? null,
    number: row.number,
    reviews: row.reviews.map((review) => ({
      body: review.body,
      comments: review.comments.map((comment) => ({
        body: comment.body,
        filePath: comment.filePath,
        line: comment.line,
        side: comment.side,
      })),
      createdAt: review.createdAt.toISOString(),
      reviewer: review.reviewer.username,
      state: review.state,
    })),
    state: row.state,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
  await store.putJson(pullJsonPath(repoPath, row.number), doc);
}

export async function createPullRequest(
  prisma: PrismaClient,
  store: PullStoreIo,
  input: CreatePullInput,
): Promise<PullSummary> {
  const title = requireText(input.title, 'title');
  const headRef = requireText(input.headRef, 'headRef');
  const baseRef = requireText(input.baseRef, 'baseRef');
  if (headRef === baseRef) throw new PullError('head and base branch must differ');
  const headOid = requireOid(input.headOid, 'headOid');
  const baseOid = requireOid(input.baseOid, 'baseOid');

  const number = await nextItemNumber(prisma, input.repoId, 'pull');
  const row = await prisma.pullRequest.create({
    data: {
      authorId: input.authorId,
      baseOid,
      baseRef,
      body: input.body ?? '',
      headOid,
      headRef,
      number,
      storagePath: pullJsonPath(input.repoPath, number),
      repoId: input.repoId,
      title,
    },
    select: SUMMARY_SELECT,
  });
  await syncDocument(prisma, store, input.repoPath, row.id);
  return toSummary(row);
}

export async function addReview(
  prisma: PrismaClient,
  store: PullStoreIo,
  input: AddReviewInput,
): Promise<void> {
  if (!REVIEW_STATES.includes(input.state)) {
    throw new PullError(`review state must be one of ${REVIEW_STATES.join(', ')}`);
  }
  for (const comment of input.comments) {
    if (!Number.isInteger(comment.line) || comment.line < 1) {
      throw new PullError('comment line must be a positive integer');
    }
    requireText(comment.filePath, 'filePath');
    requireText(comment.body, 'comment body');
  }

  const pull = await prisma.pullRequest.findUnique({
    select: { id: true },
    where: { id: input.pullRequestId },
  });
  if (!pull) throw new PullError('pull request not found');

  await prisma.pullRequestReview.create({
    data: {
      body: input.body,
      comments: {
        create: input.comments.map((comment) => ({
          body: comment.body,
          filePath: comment.filePath,
          line: comment.line,
          side: comment.side ?? 'RIGHT',
        })),
      },
      pullRequestId: input.pullRequestId,
      reviewerId: input.reviewerId,
      state: input.state,
    },
  });
  await syncDocument(prisma, store, input.repoPath, input.pullRequestId);
}

async function currentState(prisma: PrismaClient, pullRequestId: string): Promise<string> {
  const row = await prisma.pullRequest.findUnique({
    select: { state: true },
    where: { id: pullRequestId },
  });
  if (!row) throw new PullError('pull request not found');
  return row.state;
}

export async function mergePullRequest(
  prisma: PrismaClient,
  store: PullStoreIo,
  input: MergeInput,
): Promise<PullSummary> {
  if ((await currentState(prisma, input.pullRequestId)) === 'merged') {
    throw new PullError('already merged');
  }
  const row = await prisma.pullRequest.update({
    data: { mergedAt: new Date(), mergedById: input.mergedById, state: 'merged' },
    select: SUMMARY_SELECT,
    where: { id: input.pullRequestId },
  });
  await syncDocument(prisma, store, input.repoPath, row.id);
  return toSummary(row);
}

export async function setPullState(
  prisma: PrismaClient,
  store: PullStoreIo,
  input: SetPullStateInput,
): Promise<PullSummary> {
  if (input.state !== 'open' && input.state !== 'closed') {
    throw new PullError('state must be open or closed');
  }
  // 合併是終局狀態：允許改回開啟會讓已入庫的提交與 PR 狀態說法不一致。
  if ((await currentState(prisma, input.pullRequestId)) === 'merged') {
    throw new PullError('already merged');
  }
  const row = await prisma.pullRequest.update({
    data: { state: input.state },
    select: SUMMARY_SELECT,
    where: { id: input.pullRequestId },
  });
  await syncDocument(prisma, store, input.repoPath, row.id);
  return toSummary(row);
}

export async function listPullRequests(
  prisma: PrismaClient,
  repoId: string,
  state?: PullState,
): Promise<PullSummary[]> {
  const rows = await prisma.pullRequest.findMany({
    orderBy: { number: 'desc' },
    select: SUMMARY_SELECT,
    where: state ? { repoId, state } : { repoId },
  });
  return rows.map(toSummary);
}
