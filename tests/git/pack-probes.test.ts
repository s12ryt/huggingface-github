/**
 * scanPack 探測次數契約：小型物件的二分搜尋視窗受宣告大小上界約束。
 *
 * 全素食人為構造：一個小物件 + 一個大的不可壓縮物件。掃描小物件時，
 * 其後剩餘的 pack 很大；若二分上界仍取「剩餘全長」，探測次數會隨
 * pack 總大小成長；以上界 = 宣告大小的壓縮上限估計時，小物件的
 * 探測次數應與 pack 其他部分無關。
 */
import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ calls: 0 }));

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    inflateSync: ((buffer: Buffer) => {
      probe.calls += 1;
      return actual.inflateSync(buffer);
    }) as typeof actual.inflateSync,
  };
});

import { scanPack } from '@/git/pack.js';
import { buildPack } from '../helpers/pack.js';

/** 決定論偽隨機（xorshift32），確保探測計數跨執行穩定。 */
function incompressible(size: number): Buffer {
  const out = Buffer.alloc(size);
  let state = 0x9e3779b9;
  for (let i = 0; i < size; i += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out.writeUInt32BE(state >>> 0, i);
  }
  return out;
}

describe('scanPack 探測次數', () => {
  it('小物件的探測次數不隨 pack 尾部大小膨脹', () => {
    const pack = buildPack([
      { content: Buffer.from('tiny-payload\n', 'utf8'), type: 'blob' },
      { content: incompressible(300_000), type: 'blob' },
    ]).pack;

    probe.calls = 0;
    const scan = scanPack(pack);
    expect(scan.objectCount).toBe(2);

    // 舊實作（上界 = 剩餘全長 ~300KB）：小物件 ~1+log2(300K)≈20 次、
    // 大物件 ~19 次，合計 >35。新實作：小物件受宣告大小上界（≈13+64B）
    // 約束後 ~8 次，大物件不變；合計應低於此門檻。
    expect(probe.calls).toBeLessThan(32);
  });
});
