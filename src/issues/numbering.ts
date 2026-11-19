/**
 * Issue / PR 共用編號序列
 *
 * 1. nextItemNumber：以 RepoItemNumber 的唯一約束搶號，issue 與 PR 共用一條序列
 */
import type { PrismaClient } from '@prisma/client';

export type ItemKind = 'issue' | 'pull';

const MAX_ATTEMPTS = 64;

/**
 * 併發安全的取號：靠 `@@unique([repoId, number])` 讓資料庫裁決勝負，
 * 撞號就加一重試。不用 count+1 是因為那在併發下必然重號。
 */
export async function nextItemNumber(
  prisma: PrismaClient,
  repoId: string,
  kind: ItemKind,
): Promise<number> {
  const highest = await prisma.repoItemNumber.findFirst({
    orderBy: { number: 'desc' },
    select: { number: true },
    where: { repoId },
  });
  let candidate = (highest?.number ?? 0) + 1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await prisma.repoItemNumber.create({ data: { kind, number: candidate, repoId } });
      return candidate;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      candidate += 1;
    }
  }
  throw new Error('Could not allocate item number');
}
