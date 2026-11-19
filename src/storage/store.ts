/**
 * 以 HuggingFace 公開 Dataset 為後端的加密儲存層。
 *
 * 功能位置：
 * - Store / StoreIo 介面 : 行 36 — 上層（git、issue、PR）唯一依賴的契約
 * - HubStoreOptions      : 行 58 — 注入 hub 客戶端、主金鑰、快取上限
 * - createHubStore()     : 行 76 — 組裝並回傳 Store
 * - 區間讀取與合併       : 行 128 — 明文區間 → 密文區間 → 單次批次請求
 * - 快取與失效           : 行 104 — 密文片段 LRU 與每檔版面快取
 *
 * 設計要點：
 * 1. 桶是公開的，所以任何位元組在離開本進程前都已經過 AES-256-GCM 加密，
 *    而且金鑰以檔案路徑衍生，密文被搬到別的路徑就解不開。
 * 2. 上層讀 packfile 是隨機位移的，所以這裡把「明文區間」換算成「密文區塊區間」，
 *    合併相鄰需求後只發一次請求，再逐段驗證解密。
 * 3. 快取的是密文片段而不是明文，因此快取被旁人讀到也不洩漏內容。
 */

import { LruCache, type LruStats } from './lru.js';
import {
  CIPHER_HEADER_BYTES,
  DEFAULT_CHUNK_BYTES,
  cipherRangeFor,
  decryptBytes,
  decryptRange,
  deriveFileKey,
  encryptBytes,
  readCipherHeader,
  type CipherLayout,
} from './crypto.js';
import {
  DEFAULT_MAX_GAP,
  DEFAULT_MAX_SPAN,
  mergeRanges,
  sliceFromSpan,
  type ByteRange,
} from './ranges.js';

export interface Store {
  readRanges(path: string, ranges: readonly ByteRange[]): Promise<Buffer[]>;
  readAll(path: string): Promise<Buffer | null>;
  readJson<T>(path: string): Promise<T | null>;
  putBytes(path: string, body: Buffer): Promise<void>;
  putJson(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  cacheStats(): LruStats;
}

/**
 * 只列出本層真正會用到的 hub 能力，讓測試能注入輕量替身，
 * 也讓日後換成別的物件儲存時不必改動呼叫端。
 */
export interface StoreIo {
  deleteFile(path: string): Promise<void>;
  putFile(path: string, body: Buffer): Promise<void>;
  readAll(path: string): Promise<Buffer | null>;
  readRange(path: string, range: ByteRange): Promise<Buffer>;
}

export interface HubStoreOptions {
  hub: StoreIo;
  masterKey: Buffer;
  cacheMaxBytes: number;
  chunkSize?: number;
  mergeMaxGap?: number;
  mergeMaxSpan?: number;
}

export class StoreError extends Error {
  constructor(reason: string) {
    super(`Storage error: ${reason}`);
    this.name = 'StoreError';
  }
}

export function createHubStore(options: HubStoreOptions): Store {
  const { hub, masterKey } = options;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_BYTES;
  const content = new LruCache(options.cacheMaxBytes);
  const layouts = new Map<string, CipherLayout>();
  const mergeOptions = {
    ...(options.mergeMaxGap === undefined ? {} : { maxGap: options.mergeMaxGap }),
    ...(options.mergeMaxSpan === undefined ? {} : { maxSpan: options.mergeMaxSpan }),
  };

  function keyOf(path: string, range: ByteRange): string {
    return `${path}#${range.start}-${range.end}`;
  }

  function invalidate(path: string): void {
    layouts.delete(path);
    content.deletePrefix(`${path}#`);
  }

  async function layoutOf(path: string): Promise<CipherLayout> {
    const cached = layouts.get(path);
    if (cached) {
      return cached;
    }
    const head = await hub.readRange(path, { start: 0, end: CIPHER_HEADER_BYTES - 1 });
    const layout = readCipherHeader(head);
    layouts.set(path, layout);
    return layout;
  }

  /**
   * 合併後的密文區間一次取回。區間本身就是公開可見的密文，
   * 所以用區間當快取鍵是安全的，而且 pack 的相鄰物件常落在同一區塊上。
   */
  async function spanOf(path: string, span: ByteRange): Promise<Buffer> {
    const key = keyOf(path, span);
    const hit = content.get(key);
    if (hit) {
      return hit;
    }
    const bytes = await hub.readRange(path, span);
    content.set(key, bytes);
    return bytes;
  }

  async function readRanges(path: string, ranges: readonly ByteRange[]): Promise<Buffer[]> {
    if (ranges.length === 0) {
      return [];
    }
    const layout = await layoutOf(path);
    const plans = ranges.map((range) => cipherRangeFor(layout, range));
    const spans = mergeRanges(
      plans.map((plan) => plan.range),
      mergeOptions,
    );
    const fetched = new Map<string, Buffer>();
    // 各合併段彼此獨立，並行抓取以省下序列等待的往返時間
    await Promise.all(
      spans.map(async (span) => {
        fetched.set(keyOf(path, span), await spanOf(path, span));
      }),
    );
    const key = deriveFileKey(masterKey, path);
    return plans.map((plan, index) => {
      const span = spans.find(
        (candidate) => candidate.start <= plan.range.start && plan.range.end <= candidate.end,
      );
      if (!span) {
        throw new StoreError('merged span does not cover the requested range');
      }
      const body = fetched.get(keyOf(path, span));
      if (!body) {
        throw new StoreError('merged span was not fetched');
      }
      const slice = sliceFromSpan(span, body, plan.range);
      return decryptRange(key, layout, plan, slice, ranges[index] as ByteRange);
    });
  }

  async function readAll(path: string): Promise<Buffer | null> {
    const cipher = await hub.readAll(path);
    if (!cipher) {
      return null;
    }
    return decryptBytes(deriveFileKey(masterKey, path), cipher);
  }

  async function putBytes(path: string, body: Buffer): Promise<void> {
    const cipher = encryptBytes(deriveFileKey(masterKey, path), body, chunkSize);
    await hub.putFile(path, cipher);
    invalidate(path);
  }

  return {
    cacheStats: () => content.stats(),
    putBytes,
    readAll,
    readRanges,
    async putJson(path, value) {
      await putBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    },
    async readJson<T>(path: string): Promise<T | null> {
      const bytes = await readAll(path);
      if (!bytes) {
        return null;
      }
      try {
        return JSON.parse(bytes.toString('utf8')) as T;
      } catch {
        return null;
      }
    },
    async remove(path) {
      await hub.deleteFile(path);
      invalidate(path);
    },
  };
}

export { DEFAULT_MAX_GAP, DEFAULT_MAX_SPAN };
