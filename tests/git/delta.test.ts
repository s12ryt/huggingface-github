/**
 * delta 解碼測試：可變長度大小、copy/insert 指令、套用與守門。
 */
import { describe, expect, it } from 'vitest';

import { DeltaError, applyDelta, readDeltaSizes } from '@/git/delta.js';
import { makeDelta } from '../helpers/pack.js';

const base = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

describe('delta 標頭', () => {
  it('讀出 base 與 result 大小', () => {
    const result = Buffer.from('the quick brown fox!', 'utf8');
    const sizes = readDeltaSizes(makeDelta(base, result));
    expect(sizes.baseSize).toBe(base.length);
    expect(sizes.resultSize).toBe(result.length);
  });

  it('回報標頭消耗的位元組數', () => {
    const sizes = readDeltaSizes(makeDelta(base, Buffer.from('x')));
    expect(sizes.offset).toBeGreaterThan(0);
  });

  it('支援大於 127 位元組的多位元組大小編碼', () => {
    const big = Buffer.alloc(5000, 0x41);
    const sizes = readDeltaSizes(makeDelta(big, big));
    expect(sizes.baseSize).toBe(5000);
    expect(sizes.resultSize).toBe(5000);
  });

  it('空 delta 拋錯', () => {
    expect(() => readDeltaSizes(Buffer.alloc(0))).toThrow(DeltaError);
  });
});

describe('套用 delta', () => {
  it('完全相同的內容可還原', () => {
    expect(applyDelta(base, makeDelta(base, base)).toString('utf8')).toBe(base.toString('utf8'));
  });

  it('前綴相同、尾端不同可還原', () => {
    const result = Buffer.from('the quick brown fox flies away', 'utf8');
    expect(applyDelta(base, makeDelta(base, result)).toString('utf8')).toBe(result.toString('utf8'));
  });

  it('完全不同的內容可還原（純 insert）', () => {
    const result = Buffer.from('zzz totally different', 'utf8');
    expect(applyDelta(base, makeDelta(base, result)).toString('utf8')).toBe(result.toString('utf8'));
  });

  it('結果為空也可還原', () => {
    expect(applyDelta(base, makeDelta(base, Buffer.alloc(0))).length).toBe(0);
  });

  it('大內容可還原', () => {
    const big = Buffer.alloc(9000, 0x42);
    const result = Buffer.concat([big.subarray(0, 4000), Buffer.from('tail marker')]);
    expect(applyDelta(big, makeDelta(big, result)).equals(result)).toBe(true);
  });

  it('base 大小不符時拋錯', () => {
    const delta = makeDelta(base, base);
    expect(() => applyDelta(Buffer.from('wrong size base'), delta)).toThrow(DeltaError);
  });

  it('結果長度與宣告不符時拋錯', () => {
    const delta = makeDelta(base, Buffer.from('abc'));
    const truncated = delta.subarray(0, delta.length - 1);
    expect(() => applyDelta(base, truncated)).toThrow(DeltaError);
  });

  it('copy 指令超出 base 範圍時拋錯', () => {
    // sizes: base=3, result=10；指令要求從位移 0 複製 200 位元組
    const delta = Buffer.from([3, 10, 0x80 | 0x10, 200]);
    expect(() => applyDelta(Buffer.from('abc'), delta)).toThrow(DeltaError);
  });

  it('insert 指令超出 delta 緩衝時拋錯', () => {
    const delta = Buffer.from([3, 5, 5, 0x61]);
    expect(() => applyDelta(Buffer.from('abc'), delta)).toThrow(DeltaError);
  });

  it('遇到 0x00 指令時拋錯（git 保留值）', () => {
    const delta = Buffer.from([3, 3, 0x00]);
    expect(() => applyDelta(Buffer.from('abc'), delta)).toThrow(DeltaError);
  });
});
