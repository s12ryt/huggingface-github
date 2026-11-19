/**
 * HuggingFace Hub 客戶端：把公開 Dataset repository 當成位元組儲存後端。
 *
 * 功能位置：
 * - 路徑與網址組裝 : 行 70  encodePath / resolveUrl / commitUrl
 * - LFS 門檻判定   : 行 95  shouldUseLfs
 * - 重試策略       : 行 108 isRetryable / retryDelay / send
 * - 上傳與刪除     : 行 215 putFile / deleteFile（一般走 commit 內嵌，大檔走 LFS）
 * - 讀取           : 行 262 readAll / readRange / statFile（偵測並跟隨 LFS 指標）
 *
 * 為何上傳與刪除都走 commit API：
 * Hub 沒有單檔 PUT。commit 端點接收 NDJSON，第一行是標頭（摘要與分支），
 * 後續每行是一個操作（file / lfsFile / deletedFile），因此新增與刪除共用同一條路徑。
 *
 * 為何要處理 Git LFS：
 * 資料集的預設 .gitattributes 會把 *.pack 這類二進位副檔名歸到 LFS，大檔也會被轉過去。
 * LFS 檔在 git 樹裡只留一份幾十位元組的文字指標，位元組本身存在另一個端點上。
 * 若不處理，上傳會把大檔塞進 commit 的 base64 欄位（會被拒絕），
 * 讀取則會把指標文字送進解密，得到一個難以追查的失敗。
 *
 * 安全不變量：
 * 1. 錯誤訊息只寫下操作與狀態碼，不帶權杖、也不帶上游回應內容
 *    （上游可能把請求標頭回顯在錯誤頁裡，整段轉述等於把權杖寫進日誌）。
 * 2. 向協商取得的轉送網址發請求時只帶該網址自己要求的標頭，不附上 Hub 權杖
 *    （轉送目標是第三方儲存服務，不該拿到我們的憑證）。
 */

import type { ByteRange } from './ranges.js';
import {
  isLfsPointer,
  lfsOid,
  parseLfsPointer,
  requestLfsBatch,
  type LfsAction,
} from './lfs.js';

export const HUB_ORIGIN = 'https://huggingface.co';
export const MAX_RETRIES = 4;
export const BASE_BACKOFF_MS = 250;

/** 超過這個大小一律走 LFS。Hub 對 commit 內嵌的 base64 有上限，大檔塞不進去。 */
export const DEFAULT_LFS_THRESHOLD_BYTES = 10 * 1024 * 1024;

/** 協商回來的轉送網址帶有效期，重用一段時間以省掉每次讀取的協商往返。 */
export const DEFAULT_LFS_HREF_TTL_MS = 10 * 60 * 1000;

/** 資料集預設就以 LFS 追蹤的副檔名，不論大小都必須走同一條路徑。 */
export const LFS_EXTENSIONS = ['.pack', '.idx', '.bin'] as const;

export class HubError extends Error {
  readonly status: number;

  constructor(reason: string, status = 0) {
    super(`HuggingFace Hub request failed: ${reason}`);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface HubClientOptions {
  repoId: string;
  revision: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  lfsThresholdBytes?: number;
  lfsHrefTtlMs?: number;
  now?: () => number;
}

export interface HubClient {
  deleteFile: (path: string) => Promise<void>;
  putFile: (path: string, body: Buffer) => Promise<void>;
  readAll: (path: string) => Promise<Buffer | null>;
  readRange: (path: string, range: ByteRange) => Promise<Buffer>;
  statFile: (path: string) => Promise<number | null>;
}

function normalizePath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new HubError('path traversal is not allowed', 400);
  }
  return segments.join('/');
}

function encodePath(path: string): string {
  return normalizePath(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function resolveUrl(repoId: string, revision: string, path: string): string {
  return `${HUB_ORIGIN}/datasets/${repoId}/resolve/${revision}/${encodePath(path)}`;
}

export function commitUrl(repoId: string, revision: string): string {
  return `${HUB_ORIGIN}/api/datasets/${repoId}/commit/${revision}`;
}

export function shouldUseLfs(
  path: string,
  size: number,
  thresholdBytes = DEFAULT_LFS_THRESHOLD_BYTES,
): boolean {
  if (size >= thresholdBytes) {
    return true;
  }
  const lowered = path.toLowerCase();
  return LFS_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface CachedHref {
  action: LfsAction;
  expiresAt: number;
}

export function createHubClient(options: HubClientOptions): HubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const threshold = options.lfsThresholdBytes ?? DEFAULT_LFS_THRESHOLD_BYTES;
  const hrefTtl = options.lfsHrefTtlMs ?? DEFAULT_LFS_HREF_TTL_MS;
  const { repoId, revision, token } = options;
  const hrefs = new Map<string, CachedHref>();

  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return token === null ? extra : { ...extra, authorization: `Bearer ${token}` };
  }

  /**
   * 以同一套重試策略送出所有請求。回傳 null 表示上游明確回報「不存在」，
   * 由呼叫端決定那是正常結果（讀取、刪除）或錯誤（區間讀取）。
   */
  async function send(
    what: string,
    url: string,
    init: RequestInit,
    treat404AsMissing: boolean,
  ): Promise<Response | null> {
    let attempt = 0;
    for (;;) {
      const response = await fetchImpl(url, init);
      if (response.ok) {
        return response;
      }
      if (treat404AsMissing && response.status === 404) {
        return null;
      }
      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        await sleep(retryDelay(attempt, response.headers.get('retry-after')));
        attempt += 1;
        continue;
      }
      throw new HubError(`${what} returned status ${String(response.status)}`, response.status);
    }
  }

  function commitBody(operation: Record<string, unknown>, summary: string): string {
    const header = { key: 'header', value: { summary } };
    return `${JSON.stringify(header)}\n${JSON.stringify(operation)}\n`;
  }

  async function commit(
    what: string,
    operation: Record<string, unknown>,
    summary: string,
    treat404AsMissing: boolean,
  ): Promise<void> {
    if (token === null) {
      throw new HubError('write requires an access token', 401);
    }
    await send(
      what,
      commitUrl(repoId, revision),
      {
        body: commitBody(operation, summary),
        headers: authHeaders({ 'content-type': 'application/x-ndjson' }),
        method: 'POST',
      },
      treat404AsMissing,
    );
  }

  function cachedHref(target: string): LfsAction | null {
    const entry = hrefs.get(target);
    if (!entry) {
      return null;
    }
    if (now() >= entry.expiresAt) {
      hrefs.delete(target);
      return null;
    }
    return entry.action;
  }

  /** 把指標換成可直接取位元組的轉送網址，並記下有效期。 */
  async function negotiateDownload(target: string, pointerBody: Buffer): Promise<LfsAction> {
    const pointer = parseLfsPointer(pointerBody);
    const action = await requestLfsBatch({
      fetchImpl,
      oid: pointer.oid,
      operation: 'download',
      repoId,
      size: pointer.size,
      sleep,
      token,
    });
    if (!action) {
      throw new HubError('lfs download negotiation returned no location', 404);
    }
    hrefs.set(target, { action, expiresAt: now() + hrefTtl });
    return action;
  }

  async function uploadViaLfs(target: string, body: Buffer): Promise<void> {
    if (token === null) {
      throw new HubError('write requires an access token', 401);
    }
    const oid = lfsOid(body);
    const action = await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId,
      size: body.length,
      sleep,
      token,
    });
    if (action) {
      // 直接以原 Buffer 作為主體，不做整份複製；大檔上傳的峰值記憶體減半
      await send(
        'lfs upload',
        action.href,
        { body, headers: action.headers, method: 'PUT' },
        false,
      );
    }
    await commit(
      'upload',
      { key: 'lfsFile', value: { algo: 'sha256', oid, path: target, size: body.length } },
      `update ${target}`,
      false,
    );
  }

  /** 轉送目標可忽略 Range 而回整檔，那種情況下必須自行切片。 */
  function sliceIfWhole(payload: Buffer, status: number, range: ByteRange): Buffer {
    return status === 206 ? payload : payload.subarray(range.start, range.end + 1);
  }

  async function rangeFromAction(
    action: LfsAction,
    range: ByteRange,
  ): Promise<Buffer> {
    const response = await send(
      'lfs range download',
      action.href,
      {
        headers: { ...action.headers, range: `bytes=${String(range.start)}-${String(range.end)}` },
        method: 'GET',
      },
      false,
    );
    if (!response) {
      throw new HubError('lfs range download returned no content', 404);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    return sliceIfWhole(payload, response.status, range);
  }

  async function allFromAction(action: LfsAction): Promise<Buffer | null> {
    const response = await send(
      'lfs download',
      action.href,
      { headers: action.headers, method: 'GET' },
      true,
    );
    if (!response) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    async deleteFile(path) {
      const target = normalizePath(path);
      hrefs.delete(target);
      await commit(
        'delete',
        { key: 'deletedFile', value: { path: target } },
        `delete ${target}`,
        true,
      );
    },

    async putFile(path, body) {
      const target = normalizePath(path);
      hrefs.delete(target);
      if (shouldUseLfs(target, body.length, threshold)) {
        await uploadViaLfs(target, body);
        return;
      }
      await commit(
        'upload',
        {
          key: 'file',
          value: { content: body.toString('base64'), encoding: 'base64', path: target },
        },
        `update ${target}`,
        false,
      );
    },

    async readAll(path) {
      const target = normalizePath(path);
      const cached = cachedHref(target);
      if (cached) {
        return allFromAction(cached);
      }
      const response = await send(
        'download',
        resolveUrl(repoId, revision, target),
        { headers: authHeaders(), method: 'GET' },
        true,
      );
      if (!response) {
        return null;
      }
      const payload = Buffer.from(await response.arrayBuffer());
      if (!isLfsPointer(payload)) {
        return payload;
      }
      return allFromAction(await negotiateDownload(target, payload));
    },

    /**
     * 區間讀取只會取回開頭幾個位元組，所以必須先認出指標再決定走哪條路。
     * 認出指標後要重新取回完整指標才能解析 oid 與大小。
     */
    async readRange(path, range) {
      const target = normalizePath(path);
      const cached = cachedHref(target);
      if (cached) {
        return rangeFromAction(cached, range);
      }
      const response = await send(
        'range download',
        resolveUrl(repoId, revision, target),
        {
          headers: authHeaders({ range: `bytes=${String(range.start)}-${String(range.end)}` }),
          method: 'GET',
        },
        false,
      );
      if (!response) {
        throw new HubError('range download returned no content', 404);
      }
      const payload = Buffer.from(await response.arrayBuffer());
      if (!isLfsPointer(payload)) {
        return sliceIfWhole(payload, response.status, range);
      }
      const whole = await send(
        'download',
        resolveUrl(repoId, revision, target),
        { headers: authHeaders(), method: 'GET' },
        true,
      );
      if (!whole) {
        throw new HubError('range download returned no content', 404);
      }
      const pointer = Buffer.from(await whole.arrayBuffer());
      return rangeFromAction(await negotiateDownload(target, pointer), range);
    },

    /**
     * LFS 檔的 content-length 是指標長度，真正大小在 x-linked-size 裡。
     */
    async statFile(path) {
      const response = await send(
        'stat',
        resolveUrl(repoId, revision, path),
        { headers: authHeaders(), method: 'HEAD' },
        true,
      );
      if (!response) {
        return null;
      }
      const linked = Number.parseInt(response.headers.get('x-linked-size') ?? '', 10);
      if (Number.isFinite(linked)) {
        return linked;
      }
      const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      return Number.isFinite(length) ? length : null;
    },
  };
}
