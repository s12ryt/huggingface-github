/**
 * Git LFS 指標與 batch 協商。
 *
 * 功能位置：
 * - 指標偵測與解析 : 行 44  isLfsPointer / parseLfsPointer
 * - 物件識別碼     : 行 86  lfsOid
 * - batch 協商     : 行 104 batchUrl / requestLfsBatch
 *
 * 為何需要這一層：
 * HuggingFace 的資料集帶有預設的 .gitattributes，`*.pack` 這類二進位副檔名會被
 * 歸到 LFS。LFS 檔案在 git 樹裡存的是一份幾十位元組的文字指標，真正的位元組放在
 * 另一台內容伺服器上。因此寫入要先與 batch 端點協商上傳位址，讀取則要能認出
 * 「拿到的是指標而不是內容」並改去取真正的物件。
 *
 * 偵測必須在很短的前綴上成立：儲存層第一次讀一個檔案時只會取回密文檔頭那
 * 十六個位元組，如果那時認不出指標，指標文字就會被送進解密並得到一個難以追查的失敗。
 *
 * 安全不變量：
 * 錯誤訊息只寫下操作與狀態碼，不帶權杖、也不轉述上游回應內容。
 */

import { createHash } from 'node:crypto';

export const LFS_BATCH_ACCEPT = 'application/vnd.git-lfs+json';
export const LFS_POINTER_PREFIX = 'version https:';
export const LFS_POINTER_SNIFF_BYTES = LFS_POINTER_PREFIX.length;
export const LFS_HASH_ALGO = 'sha256';
export const LFS_MAX_RETRIES = 4;
export const LFS_BASE_BACKOFF_MS = 250;

const OID_PATTERN = /^[0-9a-f]{64}$/;
const HUB_ORIGIN = 'https://huggingface.co';

export class LfsError extends Error {
  readonly status: number;

  constructor(reason: string, status = 0) {
    super(`Git LFS request failed: ${reason}`);
    this.name = 'LfsError';
    this.status = status;
  }
}

export interface LfsPointer {
  oid: string;
  size: number;
}

export interface LfsAction {
  headers: Record<string, string>;
  href: string;
}

export type LfsOperation = 'download' | 'upload';

export interface LfsBatchParams {
  fetchImpl: typeof fetch;
  oid: string;
  operation: LfsOperation;
  repoId: string;
  size: number;
  sleep?: (ms: number) => Promise<void>;
  token: string | null;
}

export function isLfsPointer(body: Buffer): boolean {
  if (body.length < LFS_POINTER_SNIFF_BYTES) {
    return false;
  }
  return body.subarray(0, LFS_POINTER_SNIFF_BYTES).toString('latin1') === LFS_POINTER_PREFIX;
}

function fieldOf(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

export function parseLfsPointer(body: Buffer): LfsPointer {
  const lines = body.toString('utf8').split('\n');
  const oid = fieldOf(lines, `oid ${LFS_HASH_ALGO}:`);
  const rawSize = fieldOf(lines, 'size ');
  if (oid === null || !OID_PATTERN.test(oid)) {
    throw new LfsError('pointer has no valid sha256 object id');
  }
  const size = Number.parseInt(rawSize ?? '', 10);
  if (!Number.isInteger(size) || size < 0) {
    throw new LfsError('pointer has no valid size');
  }
  return { oid, size };
}

export function lfsOid(body: Buffer): string {
  return createHash(LFS_HASH_ALGO).update(body).digest('hex');
}

export function batchUrl(repoId: string): string {
  return `${HUB_ORIGIN}/datasets/${repoId}.git/info/lfs/objects/batch`;
}

interface BatchObject {
  actions?: Record<string, { header?: Record<string, string>; href?: string }>;
  error?: { code?: number; message?: string };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return LFS_BASE_BACKOFF_MS * 2 ** attempt;
}

/**
 * 回傳 null 表示上游沒有給動作，也就是該物件已經在儲存桶裡。
 * 這對上傳是正常結果（同一份 packfile 重複推送），不是錯誤。
 */
export async function requestLfsBatch(params: LfsBatchParams): Promise<LfsAction | null> {
  const { fetchImpl, oid, operation, repoId, size, token } = params;
  const sleep = params.sleep ?? defaultSleep;
  const headers: Record<string, string> = {
    accept: LFS_BATCH_ACCEPT,
    'content-type': LFS_BATCH_ACCEPT,
  };
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const body = JSON.stringify({
    hash_algo: LFS_HASH_ALGO,
    objects: [{ oid, size }],
    operation,
    transfers: ['basic'],
  });

  let attempt = 0;
  for (;;) {
    const response = await fetchImpl(batchUrl(repoId), { body, headers, method: 'POST' });
    if (response.ok) {
      return readAction(await response.json(), operation);
    }
    if (isRetryable(response.status) && attempt < LFS_MAX_RETRIES) {
      await sleep(backoff(attempt, response.headers.get('retry-after')));
      attempt += 1;
      continue;
    }
    throw new LfsError(
      `${operation} negotiation returned status ${String(response.status)}`,
      response.status,
    );
  }
}

function readAction(payload: unknown, operation: LfsOperation): LfsAction | null {
  const objects = (payload as { objects?: BatchObject[] } | null)?.objects;
  const first = Array.isArray(objects) ? objects[0] : undefined;
  if (!first) {
    throw new LfsError(`${operation} negotiation returned no object`);
  }
  if (first.error) {
    throw new LfsError(
      `${operation} negotiation rejected the object`,
      typeof first.error.code === 'number' ? first.error.code : 0,
    );
  }
  const action = first.actions?.[operation];
  if (!action?.href) {
    return null;
  }
  return { headers: action.header ?? {}, href: action.href };
}
