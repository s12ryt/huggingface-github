/**
 * 有界 LRU 內容快取測試（E+6 優化驗收）。
 *
 * 1. 基本存取     — set / get / has / delete / clear
 * 2. 容量驅逐     — 依位元組上限驅逐最久未用者
 * 3. LRU 順序     — get 與覆寫會刷新新鮮度
 * 4. 統計與守門   — size/bytes/hits/misses、超大項目拒收
 */
import { describe, expect, it } from 'vitest';

import { LruCache } from '@/storage/lru.js';

const buf = (size: number, fill = 0x61): Buffer => Buffer.alloc(size, fill);

describe('LruCache — 基本存取', () => {
  it('存入後可取出相同內容', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    expect(cache.get('a')?.length).toBe(10);
  });

  it('未存在的鍵回 undefined', () => {
    expect(new LruCache(1024).get('missing')).toBeUndefined();
  });

  it('has 不影響新鮮度而 get 會', () => {
    const cache = new LruCache(30);
    cache.set('a', buf(10));
    cache.set('b', buf(10));
    cache.has('a');
    cache.get('b');
    cache.set('c', buf(10));
    cache.set('d', buf(10));
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('delete 移除項目並回報是否命中', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear 清空全部並歸零位元組計數', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    cache.set('b', buf(20));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('覆寫同一鍵不會重複累加位元組', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    cache.set('a', buf(40));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(40);
  });
});

describe('LruCache — 容量驅逐', () => {
  it('超過上限時驅逐最久未使用者', () => {
    const cache = new LruCache(100);
    cache.set('a', buf(50));
    cache.set('b', buf(50));
    cache.set('c', buf(50));
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('驅逐後位元組總量不超過上限', () => {
    const cache = new LruCache(100);
    for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, buf(30));
    expect(cache.bytes).toBeLessThanOrEqual(100);
  });

  it('get 會刷新新鮮度，使該項不被優先驅逐', () => {
    const cache = new LruCache(100);
    cache.set('a', buf(40));
    cache.set('b', buf(40));
    cache.get('a');
    cache.set('c', buf(40));
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('單一項目超過上限時拒收，且不驅逐既有內容', () => {
    const cache = new LruCache(100);
    cache.set('keep', buf(50));
    expect(cache.set('huge', buf(200))).toBe(false);
    expect(cache.has('huge')).toBe(false);
    expect(cache.has('keep')).toBe(true);
  });

  it('剛好等於上限的項目可存入', () => {
    const cache = new LruCache(100);
    expect(cache.set('exact', buf(100))).toBe(true);
    expect(cache.bytes).toBe(100);
  });

  it('上限為 0 時任何項目都拒收', () => {
    const cache = new LruCache(0);
    expect(cache.set('a', buf(1))).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('負的上限視為 0', () => {
    const cache = new LruCache(-10);
    expect(cache.set('a', buf(1))).toBe(false);
  });
});

describe('LruCache — 統計', () => {
  it('命中與未命中分別計數', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    cache.get('a');
    cache.get('a');
    cache.get('b');
    expect(cache.hits).toBe(2);
    expect(cache.misses).toBe(1);
  });

  it('stats 回傳快照且含全部欄位', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    cache.get('a');
    expect(cache.stats()).toEqual({
      bytes: 10,
      capacity: 1024,
      hits: 1,
      misses: 0,
      size: 1,
    });
  });

  it('clear 不重置命中統計，便於長期觀測', () => {
    const cache = new LruCache(1024);
    cache.set('a', buf(10));
    cache.get('a');
    cache.clear();
    expect(cache.hits).toBe(1);
  });

  it('被驅逐的項目再次讀取算未命中', () => {
    const cache = new LruCache(50);
    cache.set('a', buf(40));
    cache.set('b', buf(40));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.misses).toBe(1);
  });
});
