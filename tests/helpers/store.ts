/**
 * 共用的假儲存層（記憶體版，不加密）。
 * - createFakeStore：回傳符合 Store 介面的實例並記錄 readRanges 次數（第 19 行）
 *
 * 這裡刻意不走加密：上層（git、issues、pulls）只依賴 Store 契約，
 * 加密是否正確由 tests/storage/store.test.ts 自己驗證。
 */
import type { ByteRange } from '@/storage/ranges.js';

export interface FakeStore {
  files: Map<string, Buffer>;
  rangeCalls: number;
  readRanges(path: string, ranges: readonly ByteRange[]): Promise<Buffer[]>;
  readAll(path: string): Promise<Buffer | null>;
  readJson<T>(path: string): Promise<T | null>;
  putBytes(path: string, body: Buffer): Promise<void>;
  putJson(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  cacheStats(): { bytes: number; capacity: number; hits: number; misses: number; size: number };
}

export function createFakeStore(): FakeStore {
  const files = new Map<string, Buffer>();

  return {
    files,
    rangeCalls: 0,
    async readRanges(path, ranges) {
      this.rangeCalls += 1;
      const data = files.get(path);
      if (!data) throw new Error(`missing ${path}`);
      return ranges.map((range) => data.subarray(range.start, range.end + 1));
    },
    async readAll(path) {
      return files.get(path) ?? null;
    },
    async readJson(path) {
      const data = files.get(path);
      return data ? JSON.parse(data.toString('utf8')) : null;
    },
    async putBytes(path, body) {
      files.set(path, Buffer.from(body));
    },
    async putJson(path, value) {
      files.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    },
    async remove(path) {
      files.delete(path);
    },
    cacheStats() {
      return { bytes: 0, capacity: 0, hits: 0, misses: 0, size: 0 };
    },
  };
}
