/**
 * Repo 權限判定：可見性、協作者角色、擁有者與站台管理員。
 *
 * - COLLABORATOR_ROLES / isCollaboratorRole：角色白名單
 * - resolveAccess：彙整單一 repo 對某身分的存取事實
 * - canRead / canWrite：由事實推導讀寫許可
 */
import type { PrismaClient } from '@prisma/client';

export const COLLABORATOR_ROLES = ['read', 'write', 'admin'] as const;

export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

const WRITE_ROLES: readonly string[] = ['write', 'admin'];

export interface AccessActor {
  id: string;
  role: string;
}

export interface RepoAccess {
  exists: boolean;
  isOwner: boolean;
  isPublic: boolean;
  isSiteAdmin: boolean;
  repoId: string;
  role: CollaboratorRole | null;
}

export function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return typeof value === 'string' && (COLLABORATOR_ROLES as readonly string[]).includes(value);
}

export async function resolveAccess(
  prisma: PrismaClient,
  repoId: string,
  actor: AccessActor | null,
): Promise<RepoAccess> {
  // repo 與 collaborator 兩筆查詢都以 repoId 為鍵、互不依賴，並行發出。
  const [repo, link] = await Promise.all([
    prisma.repo.findUnique({
      select: { ownerId: true, visibility: true },
      where: { id: repoId },
    }),
    actor
      ? prisma.collaborator.findUnique({
          select: { role: true },
          where: { repoId_userId: { repoId, userId: actor.id } },
        })
      : null,
  ]);

  if (!repo) {
    return {
      exists: false,
      isOwner: false,
      isPublic: false,
      isSiteAdmin: actor?.role === 'admin',
      repoId,
      role: null,
    };
  }

  const role = link && isCollaboratorRole(link.role) ? link.role : null;

  return {
    exists: true,
    isOwner: actor?.id === repo.ownerId,
    isPublic: repo.visibility === 'public',
    isSiteAdmin: actor?.role === 'admin',
    repoId,
    role,
  };
}

export function canRead(access: RepoAccess): boolean {
  if (!access.exists) return false;
  return access.isPublic || access.isOwner || access.isSiteAdmin || access.role !== null;
}

export function canWrite(access: RepoAccess): boolean {
  if (!access.exists) return false;
  return access.isOwner || access.isSiteAdmin || WRITE_ROLES.includes(access.role ?? '');
}
