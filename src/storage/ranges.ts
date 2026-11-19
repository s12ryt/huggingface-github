/**
 * 位元組區間工具（E+4：相鄰 Range 合併）。
 *
 * - RangeError   — 區間守門錯誤
 * - spanLength   — 區間長度
 * - mergeRanges  — 排序後依間隙與跨度閾值合併
 * - rangeHeader  — 組 HTTP Range 標頭
 * - sliceFromSpan— 從合併段切回原始段
 */

export interface ByteRange {
  start: number;
  end: number;
}

export interface MergeOptions {
  maxGap?: number;
  maxSpan?: number;
}

/** 間隙小於此值就併進同一次請求，寧可多抓幾個位元組也少一次往返。 */
export const DEFAULT_MAX_GAP = 64 * 1024;

/** 單次請求的跨度上限，避免為了省往返而抓下整個 packfile。 */
export const DEFAULT_MAX_SPAN = 8 * 1024 * 1024;

export class RangeError extends Error {
  constructor(reason: string) {
    super(`Invalid byte range: ${reason}`);
    this.name = 'RangeError';
  }
}

function assertRange(range: ByteRange): void {
  const { end, start } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError('start and end must be integers');
  }
  if (start < 0) throw new RangeError('start must not be negative');
  if (end < start) throw new RangeError('end must not precede start');
}

export function spanLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

export function mergeRanges(ranges: readonly ByteRange[], options: MergeOptions = {}): ByteRange[] {
  for (const range of ranges) assertRange(range);
  if (ranges.length === 0) return [];

  const maxGap = options.maxGap ?? DEFAULT_MAX_GAP;
  const maxSpan = options.maxSpan ?? DEFAULT_MAX_SPAN;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ByteRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined) {
      merged.push({ ...range });
      continue;
    }
    const gap = range.start - last.end - 1;
    const end = Math.max(last.end, range.end);
    if (gap <= maxGap && end - last.start + 1 <= maxSpan) {
      last.end = end;
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}

export function rangeHeader(ranges: readonly ByteRange[]): string {
  if (ranges.length === 0) throw new RangeError('header requires at least one range');
  return `bytes=${ranges.map((range) => `${range.start}-${range.end}`).join(',')}`;
}

export function sliceFromSpan(span: ByteRange, body: Buffer, wanted: ByteRange): Buffer {
  if (body.length !== spanLength(span)) {
    throw new RangeError('payload length does not match the fetched span');
  }
  if (wanted.start < span.start || wanted.end > span.end) {
    throw new RangeError('requested range falls outside the fetched span');
  }
  const offset = wanted.start - span.start;
  return body.subarray(offset, offset + spanLength(wanted));
}
