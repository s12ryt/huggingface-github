/**
 * 有界 LRU 位元組快取（E+6：內容快取，預設上限由設定檔決定）。
 *
 * - get/set/has/delete/clear — 基本存取，get 會刷新新鮮度
 * - 容量驅逐                 — 以位元組為單位，超限時驅逐最久未用者
 * - stats                    — size / bytes / capacity / hits / misses
 */

export interface LruStats {
  bytes: number;
  capacity: number;
  hits: number;
  misses: number;
  size: number;
}

export class LruCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly capacity: number;
  private used = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(capacityBytes: number) {
    this.capacity = Math.max(0, Math.floor(capacityBytes));
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.used;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Buffer): boolean {
    this.delete(key);
    if (value.length > this.capacity) return false;

    while (this.used + value.length > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.delete(oldest.value);
    }

    this.entries.set(key, value);
    this.used += value.length;
    return true;
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) return false;
    this.entries.delete(key);
    this.used -= value.length;
    return true;
  }

  /** 清除所有以 `prefix` 開頭的鍵，用於單一檔案被改寫後的失效。 */
  deletePrefix(prefix: string): number {
    let removed = 0;
    // Map 迭代中刪除當前鍵是規範保證安全的，免掉複製整份鍵陣列。
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && this.delete(key)) removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  stats(): LruStats {
    return {
      bytes: this.used,
      capacity: this.capacity,
      hits: this.hitCount,
      misses: this.missCount,
      size: this.entries.size,
    };
  }
}
