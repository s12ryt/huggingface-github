/**
 * Repo 服務層：建立、查詢、列表、協作者維護。
 *
 * - REPO_VISIBILITIES / isVisibility：可見性白名單
 * - repoStoragePath：儲存桶 上的 repo 根路徑
 * - createRepo：建立並回報重名
 * - findRepoByPath / listAccessibleRepos：查詢
 * - setCollaborator / removeCollaborator / listCollaborators：協作者維護
 */
import type { PrismaClient } from '@prisma/client';

import { normalizeRepoName } from './name.js';

export const REPO_VISIBILITIES = ['public', 'private'] as const;
export type RepoVisibility = (typeof REPO_VISIBILITIES)[number];

export interface RepoSummary {
  defaultBranch: string;
  description: string | null;
  id: string;
  name: string;
  owner: string;
  visibility: string;
}

export interface CreateRepoInput {
  description?: string;
  name: unknown;
  ownerId: string;
  ownerUsername: string;
  visibility?: string;
}

export class RepoExistsError extends Error {
  constructor() {
    super('Repository already exists');
    this.name = 'RepoExistsError';
  }
}

export function isVisibility(value: unknown): value is RepoVisibility {
  return typeof value === 'string' && (REPO_VISIBILITIES as readonly string[]).includes(value);
}

export function repoStoragePath(ownerUsername: string, name: string): string {
  return `/repos/${ownerUsername}/${name}`;
}

const SUMMARY_SELECT = {
  defaultBranch: true,
  description: true,
  id: true,
  name: true,
  owner: { select: { username: true } },
  visibility: true,
} as const;

type SummaryRow = {
  defaultBranch: string;
  description: string | null;
  id: string;
  name: string;
  owner: { username: string };
  visibility: string;
};

function toSummary(row: SummaryRow): RepoSummary {
  return {
    defaultBranch: row.defaultBranch,
    description: row.description,
    id: row.id,
    name: row.name,
    owner: row.owner.username,
    visibility: row.visibility,
  };
}

export async function createRepo(prisma: PrismaClient, input: CreateRepoInput): Promise<RepoSummary> {
  const name = normalizeRepoName(input.name);
  const visibility = input.visibility ?? 'private';
  try {
    const row = await prisma.repo.create({
      data: {
        ...(input.description === undefined ? {} : { description: input.description }),
        name,
        storagePath: repoStoragePath(input.ownerUsername, name),
        ownerId: input.ownerId,
        visibility,
      },
      select: SUMMARY_SELECT,
    });
    return toSummary(row);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw new RepoExistsError();
    throw error;
  }
}

export async function findRepoByPath(
  prisma: PrismaClient,
  ownerUsername: string,
  name: string,
): Promise<RepoSummary | null> {
  const row = await prisma.repo.findFirst({
    select: SUMMARY_SELECT,
    where: { name, owner: { username: ownerUsername.toLowerCase() } },
  });
  return row ? toSummary(row) : null;
}

/** 只回擁有或協作中的 repo，不洩漏他人的私有 repo。 */
export async function listAccessibleRepos(prisma: PrismaClient, userId: string): Promise<RepoSummary[]> {
  const rows = await prisma.repo.findMany({
    orderBy: { name: 'asc' },
    select: SUMMARY_SELECT,
    where: { OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }] },
  });
  return rows.map(toSummary);
}

export interface CollaboratorSummary {
  role: string;
  username: string;
}

export async function setCollaborator(
  prisma: PrismaClient,
  repoId: string,
  userId: string,
  role: string,
): Promise<void> {
  await prisma.collaborator.upsert({
    create: { repoId, role, userId },
    update: { role },
    where: { repoId_userId: { repoId, userId } },
  });
}

export async function removeCollaborator(
  prisma: PrismaClient,
  repoId: string,
  userId: string,
): Promise<boolean> {
  const { count } = await prisma.collaborator.deleteMany({ where: { repoId, userId } });
  return count === 1;
}

export async function listCollaborators(
  prisma: PrismaClient,
  repoId: string,
): Promise<CollaboratorSummary[]> {
  const rows = await prisma.collaborator.findMany({
    orderBy: { createdAt: 'asc' },
    select: { role: true, user: { select: { username: true } } },
    where: { repoId },
  });
  return rows.map((row) => ({ role: row.role, username: row.user.username }));
}
