/**
 * Pull Request 的 儲存桶 權威副本格式
 *
 * 1. pullJsonPath：JSON 檔路徑
 * 2. PullDocument / PullReviewDocument：可讀的真相格式
 * 3. loadPullDocument：讀回權威副本（缺檔或壞檔回 null）
 */
export interface PullReviewCommentDocument {
  body: string;
  filePath: string;
  line: number;
  side: string;
}

export interface PullReviewDocument {
  body: string;
  comments: PullReviewCommentDocument[];
  createdAt: string;
  reviewer: string;
  state: string;
}

export interface PullDocument {
  author: string;
  baseOid: string;
  baseRef: string;
  body: string;
  createdAt: string;
  headOid: string;
  headRef: string;
  mergedAt: string | null;
  mergedBy: string | null;
  number: number;
  reviews: PullReviewDocument[];
  state: string;
  title: string;
  updatedAt: string;
}

export interface PullStoreIo {
  putJson: (path: string, value: unknown) => Promise<unknown>;
  readJson: (path: string) => Promise<unknown>;
}

export function pullJsonPath(repoPath: string, number: number): string {
  return `${repoPath}/pulls/${number}.json`;
}

export function isPullDocument(value: unknown): value is PullDocument {
  const doc = value as Partial<PullDocument> | null;
  if (typeof doc?.title !== 'string' || typeof doc.number !== 'number') return false;
  if (typeof doc.headRef !== 'string' || typeof doc.baseRef !== 'string') return false;
  return Array.isArray(doc.reviews);
}

export async function loadPullDocument(
  store: PullStoreIo,
  repoPath: string,
  number: number,
): Promise<PullDocument | null> {
  const raw = await store.readJson(pullJsonPath(repoPath, number)).catch(() => null);
  return isPullDocument(raw) ? raw : null;
}
