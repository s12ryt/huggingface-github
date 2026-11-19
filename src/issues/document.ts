/**
 * Issue 的 儲存桶 權威副本格式
 *
 * 1. issueJsonPath：JSON 檔路徑
 * 2. IssueDocument / IssueCommentDocument：可讀的真相格式
 * 3. loadIssueDocument：讀回權威副本（缺檔或壞檔回 null）
 * 4. isIssueDocument：讀入時的形狀守門
 */
export interface IssueCommentDocument {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDocument {
  author: string;
  body: string;
  closedAt: string | null;
  comments: IssueCommentDocument[];
  createdAt: string;
  number: number;
  state: string;
  title: string;
  updatedAt: string;
}

export interface IssueStoreIo {
  putJson: (path: string, value: unknown) => Promise<unknown>;
  readJson: (path: string) => Promise<unknown>;
}

export function issueJsonPath(repoPath: string, number: number): string {
  return `${repoPath}/issues/${number}.json`;
}

function isComment(value: unknown): value is IssueCommentDocument {
  const row = value as Partial<IssueCommentDocument> | null;
  return typeof row?.author === 'string' && typeof row.body === 'string';
}

export function isIssueDocument(value: unknown): value is IssueDocument {
  const doc = value as Partial<IssueDocument> | null;
  if (typeof doc?.title !== 'string' || typeof doc.number !== 'number') return false;
  if (typeof doc.author !== 'string' || typeof doc.state !== 'string') return false;
  return Array.isArray(doc.comments) && doc.comments.every(isComment);
}

export async function loadIssueDocument(
  store: IssueStoreIo,
  repoPath: string,
  number: number,
): Promise<IssueDocument | null> {
  const raw = await store.readJson(issueJsonPath(repoPath, number)).catch(() => null);
  return isIssueDocument(raw) ? raw : null;
}
