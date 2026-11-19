/**
 * Range 合併與多段切片的測試（E+4 優化驗收）。
 *
 * 1. mergeRanges   — 排序、重疊合併、間隙閾值、跨度上限
 * 2. rangeHeader   — 單段與多段 HTTP Range 標頭組裝
 * 3. sliceFromSpan — 從合併後的大段切回原始請求段
 * 4. 守門          — 拒絕負值、end < start、非整數
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_GAP,
  DEFAULT_MAX_SPAN,
  mergeRanges,
  rangeHeader,
  RangeError as ByteRangeError,
  sliceFromSpan,
  spanLength,
  type ByteRange,
} from '@/storage/ranges.js';

const r = (start: number, end: number): ByteRange => ({ start, end });

describe('mergeRanges — 相鄰與重疊合併', () => {
  it('空輸入回空陣列', () => {
    expect(mergeRanges([])).toEqual([]);
  });

  it('單一段原樣回傳', () => {
    expect(mergeRanges([r(10, 20)])).toEqual([r(10, 20)]);
  });

  it('未排序的輸入會先排序', () => {
    expect(mergeRanges([r(100, 110), r(0, 10)], { maxGap: 0 })).toEqual([r(0, 10), r(100, 110)]);
  });

  it('完全重疊的兩段合併成一段', () => {
    expect(mergeRanges([r(0, 100), r(20, 50)])).toEqual([r(0, 100)]);
  });

  it('部分重疊的兩段合併成聯集', () => {
    expect(mergeRanges([r(0, 100), r(50, 180)])).toEqual([r(0, 180)]);
  });

  it('緊鄰的兩段（end + 1 === next.start）合併', () => {
    expect(mergeRanges([r(0, 99), r(100, 199)], { maxGap: 0 })).toEqual([r(0, 199)]);
  });

  it('間隙小於等於 maxGap 時合併，連帶抓進中間不需要的位元組', () => {
    expect(mergeRanges([r(0, 99), r(150, 199)], { maxGap: 50 })).toEqual([r(0, 199)]);
  });

  it('間隙大於 maxGap 時不合併', () => {
    expect(mergeRanges([r(0, 99), r(200, 299)], { maxGap: 50 })).toEqual([r(0, 99), r(200, 299)]);
  });

  it('合併後跨度超過 maxSpan 時不合併，避免抓下過大區塊', () => {
    expect(mergeRanges([r(0, 99), r(120, 199)], { maxGap: 1000, maxSpan: 150 })).toEqual([
      r(0, 99),
      r(120, 199),
    ]);
  });

  it('連鎖合併：三段可併為一段', () => {
    expect(mergeRanges([r(0, 10), r(11, 20), r(21, 30)], { maxGap: 0 })).toEqual([r(0, 30)]);
  });

  it('不修改傳入的陣列', () => {
    const input = [r(100, 110), r(0, 10)];
    mergeRanges(input);
    expect(input[0]).toEqual(r(100, 110));
  });

  it('預設閾值為對外公開的常數', () => {
    expect(DEFAULT_MAX_GAP).toBeGreaterThan(0);
    expect(DEFAULT_MAX_SPAN).toBeGreaterThan(DEFAULT_MAX_GAP);
  });

  it('預設閾值下，相距 1 位元組的兩段會合併', () => {
    expect(mergeRanges([r(0, 99), r(101, 199)])).toEqual([r(0, 199)]);
  });
});

describe('mergeRanges — 輸入守門', () => {
  it.each([
    ['負起點', r(-1, 10)],
    ['end 小於 start', r(10, 5)],
    ['非整數起點', r(1.5, 10)],
    ['非整數終點', r(0, 10.5)],
  ])('拒絕 %s', (_label, range) => {
    expect(() => mergeRanges([range])).toThrow(ByteRangeError);
  });

  it('錯誤訊息指出問題欄位', () => {
    expect(() => mergeRanges([r(10, 5)])).toThrow(/range/i);
  });

  it('單點段（start === end）合法', () => {
    expect(mergeRanges([r(5, 5)])).toEqual([r(5, 5)]);
  });
});

describe('rangeHeader', () => {
  it('單段產生 bytes=start-end', () => {
    expect(rangeHeader([r(0, 99)])).toBe('bytes=0-99');
  });

  it('多段以逗號分隔', () => {
    expect(rangeHeader([r(0, 99), r(200, 299)])).toBe('bytes=0-99,200-299');
  });

  it('空陣列拋錯而非產生畸形標頭', () => {
    expect(() => rangeHeader([])).toThrow(ByteRangeError);
  });
});

describe('spanLength', () => {
  it('長度為 end - start + 1', () => {
    expect(spanLength(r(0, 99))).toBe(100);
  });

  it('單點段長度為 1', () => {
    expect(spanLength(r(7, 7))).toBe(1);
  });
});

describe('sliceFromSpan — 從合併段切回原始段', () => {
  const payload = Buffer.from('0123456789');

  it('切出完整對應的子段', () => {
    expect(sliceFromSpan(r(0, 9), payload, r(2, 4)).toString()).toBe('234');
  });

  it('合併段起點非 0 時仍正確換算偏移', () => {
    const span = r(100, 109);
    expect(sliceFromSpan(span, payload, r(103, 105)).toString()).toBe('345');
  });

  it('請求段等於合併段時回傳整段', () => {
    expect(sliceFromSpan(r(0, 9), payload, r(0, 9)).toString()).toBe('0123456789');
  });

  it('請求段超出合併段範圍時拋錯', () => {
    expect(() => sliceFromSpan(r(0, 9), payload, r(5, 20))).toThrow(ByteRangeError);
  });

  it('緩衝區長度與合併段不符時拋錯，避免回傳錯位資料', () => {
    expect(() => sliceFromSpan(r(0, 99), payload, r(0, 9))).toThrow(ByteRangeError);
  });
});
