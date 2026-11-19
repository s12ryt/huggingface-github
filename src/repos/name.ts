/**
 * Repo 名稱守門。
 *
 * - REPO_NAME_PATTERN：首尾英數，中間允許 - _ .
 * - RESERVED_REPO_NAMES：避免與 git 內部命名衝突
 * - normalizeRepoName：驗證並回傳正規化名稱，不合法則拋錯
 */
export const REPO_NAME_MIN_LENGTH = 3;
export const REPO_NAME_MAX_LENGTH = 100;
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,98}[a-zA-Z0-9]$/;

/** 這些名稱會讓 git 路徑語意混淆，一律拒絕。 */
export const RESERVED_REPO_NAMES = new Set(['.git', 'git', 'objects', 'refs', 'info', 'hooks']);

export class RepoNameError extends Error {
  constructor() {
    super('Repository name rejected');
    this.name = 'RepoNameError';
  }
}

export function normalizeRepoName(input: unknown): string {
  if (typeof input !== 'string') throw new RepoNameError();
  const name = input.trim();
  if (!REPO_NAME_PATTERN.test(name)) throw new RepoNameError();
  if (RESERVED_REPO_NAMES.has(name.toLowerCase())) throw new RepoNameError();
  return name;
}
