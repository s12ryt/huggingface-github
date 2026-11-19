/**
 * packfile 掃描與索引序列化。
 *
 * - scanPack：驗證標頭、逐筆讀出物件位移與大小
 * - delta 展平（E+2）：ofs_delta / ref_delta 解析為由近到遠的 base oid 清單
 * - serializeIndex / parseIndexDocument：索引 JSON（E+1 權威副本格式）
 */
import { inflateSync } from 'node:zlib';

import { applyDelta } from './delta.js';
import { isGitObjectType, oidOf, type GitObjectType } from './object.js';

export const PACK_SIGNATURE = 'PACK';
export const PACK_VERSION = 2;
export const PACK_INDEX_VERSION = 1;
export const PACK_TRAILER_BYTES = 20;

const TYPE_BY_CODE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export class PackError extends Error {
  constructor(reason: string) {
    super(`Invalid packfile: ${reason}`);
    this.name = 'PackError';
  }
}

export interface PackEntry {
  deltaChain: string[];
  inflatedSize: number;
  oid: string;
  objectType: GitObjectType;
  packOffset: number;
  storedSize: number;
  type: GitObjectType;
}

export interface PackScan {
  entries: PackEntry[];
  objectCount: number;
}

export interface PackIndexDocument {
  entries: PackEntry[];
  objectCount: number;
  packName: string;
  version: number;
}

interface RawRecord {
  baseOffset?: number;
  baseOid?: string;
  code: number;
  declaredSize: number;
  offset: number;
  payload: Buffer;
  storedSize: number;
}

function readObjectHeader(pack: Buffer, start: number): { code: number; offset: number; size: number } {
  const first = pack[start];
  if (first === undefined) throw new PackError('truncated object header');
  const code = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 16;
  let offset = start + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    const next = pack[offset];
    if (next === undefined) throw new PackError('truncated object header');
    offset += 1;
    size += (next & 0x7f) * shift;
    shift *= 128;
    byte = next;
  }
  return { code, offset, size };
}

function readOffsetDelta(pack: Buffer, start: number): { offset: number; value: number } {
  let offset = start;
  let byte = pack[offset];
  if (byte === undefined) throw new PackError('truncated delta offset');
  offset += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = pack[offset] ?? -1;
    if (byte < 0) throw new PackError('truncated delta offset');
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { offset, value };
}

function inflateRecord(pack: Buffer, start: number, declaredSize: number): { consumed: number; data: Buffer } {
  const slice = pack.subarray(start);
  let data: Buffer;
  let consumed: number;
  try {
    // zlib 需要知道實際消耗量才能定位下一個物件；用 inflateSync 無法取得，
    // 因此逐步擴大視窗直到解壓成功並且長度符合宣告值。
    const result = inflateWithConsumed(slice, declaredSize);
    data = result.data;
    consumed = result.consumed;
  } catch {
    throw new PackError('object payload is not zlib data');
  }
  if (data.length !== declaredSize) throw new PackError('declared size does not match payload');
  return { consumed, data };
}

/**
 * 壓縮結果的估計上界：多數物件壓得比原文小；不可壓縮內容最差以
 * stored block 扴載（每 65535B 加 5B 標頭）再加 zlib 框架。此值是
 * 啟發式加速器而非正確性依據——先在上界探一次，失敗即回退全長搜尋。
 */
function compressedUpperBound(declaredSize: number): number {
  return declaredSize + Math.ceil(declaredSize / 65535) * 5 + 64;
}

function inflateWithConsumed(slice: Buffer, declaredSize: number): { consumed: number; data: Buffer } {
  const data = inflateSync(slice);
  // 以二分法找出最短的可解壓前綴，即該物件實際佔用的位元組數。
  const search = (high: number): number => {
    let low = 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      try {
        inflateSync(slice.subarray(0, mid));
        high = mid;
      } catch {
        low = mid + 1;
      }
    }
    return low;
  };

  const bounded = Math.min(slice.length, compressedUpperBound(declaredSize));
  if (bounded < slice.length) {
    try {
      // 上界內可解壓 → 真實消耗量必在其中，窗內二分使小物件
      // 的探測次數與 pack 其餘部分大小無關。
      inflateSync(slice.subarray(0, bounded));
      return { consumed: search(bounded), data };
    } catch {
      // 估計失準（少數壓縮實作差異），只浪費一次探測，回退全長。
    }
  }
  return { consumed: search(slice.length), data };
}

function readRecords(pack: Buffer, objectCount: number): RawRecord[] {
  const records: RawRecord[] = [];
  let cursor = 12;
  const limit = pack.length - PACK_TRAILER_BYTES;

  for (let i = 0; i < objectCount; i += 1) {
    if (cursor >= limit) throw new PackError('object count exceeds packfile contents');
    const offset = cursor;
    const header = readObjectHeader(pack, cursor);
    cursor = header.offset;

    const record: RawRecord = {
      code: header.code,
      declaredSize: header.size,
      offset,
      payload: Buffer.alloc(0),
      storedSize: 0,
    };

    if (header.code === OFS_DELTA) {
      const rel = readOffsetDelta(pack, cursor);
      cursor = rel.offset;
      record.baseOffset = offset - rel.value;
    } else if (header.code === REF_DELTA) {
      record.baseOid = pack.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    } else if (!TYPE_BY_CODE[header.code]) {
      throw new PackError('unknown object type code');
    }

    const inflated = inflateRecord(pack, cursor, header.size);
    record.payload = inflated.data;
    cursor += inflated.consumed;
    record.storedSize = cursor - offset;
    records.push(record);
  }

  if (cursor !== limit) throw new PackError('declared object count does not match packfile length');
  return records;
}

interface Resolved {
  chain: string[];
  content: Buffer;
  oid: string;
  type: GitObjectType;
}

function resolveRecords(records: RawRecord[]): Map<number, Resolved> {
  const byOffset = new Map<number, Resolved>();
  const byOid = new Map<string, Resolved>();
  const offsetOfOid = new Map<string, number>();

  for (const record of records) {
    const type = TYPE_BY_CODE[record.code];
    if (type) {
      const resolved: Resolved = { chain: [], content: record.payload, oid: oidOf(type, record.payload), type };
      byOffset.set(record.offset, resolved);
      byOid.set(resolved.oid, resolved);
      offsetOfOid.set(resolved.oid, record.offset);
    }
  }

  let pending = records.filter((record) => !TYPE_BY_CODE[record.code]);
  while (pending.length > 0) {
    const next: RawRecord[] = [];
    for (const record of pending) {
      const base =
        record.baseOffset !== undefined
          ? byOffset.get(record.baseOffset)
          : byOid.get(record.baseOid ?? '');
      if (!base) {
        next.push(record);
        continue;
      }
      const content = applyDelta(base.content, record.payload);
      const resolved: Resolved = {
        chain: [base.oid, ...base.chain],
        content,
        oid: oidOf(base.type, content),
        type: base.type,
      };
      byOffset.set(record.offset, resolved);
      byOid.set(resolved.oid, resolved);
    }
    if (next.length === pending.length) throw new PackError('delta base is missing from packfile');
    pending = next;
  }

  return byOffset;
}

export function scanPack(pack: Buffer): PackScan {
  if (pack.length < 12 + PACK_TRAILER_BYTES) throw new PackError('buffer is too small');
  if (pack.subarray(0, 4).toString('ascii') !== PACK_SIGNATURE) throw new PackError('bad signature');
  if (pack.readUInt32BE(4) !== PACK_VERSION) throw new PackError('unsupported version');

  const objectCount = pack.readUInt32BE(8);
  const records = readRecords(pack, objectCount);
  const resolved = resolveRecords(records);

  const entries = records.map((record) => {
    const item = resolved.get(record.offset);
    if (!item) throw new PackError('delta base is missing from packfile');
    return {
      deltaChain: item.chain,
      inflatedSize: item.content.length,
      oid: item.oid,
      objectType: item.type,
      packOffset: record.offset,
      storedSize: record.storedSize,
      type: item.type,
    } satisfies PackEntry;
  });

  return { entries, objectCount };
}

/**
 * 解碼單一 pack 記錄切片（供物件讀取器使用）。
 *
 * slice 必須是由索引三元組 (packOffset, storedSize) 取下的位元組，
 * 回傳已 inflate 的裸酬載；delta 記錄回傳的是 delta 指令本身。
 */
export function decodeRecordSlice(slice: Buffer): { code: number; payload: Buffer } {
  const header = readObjectHeader(slice, 0);
  let cursor = header.offset;

  if (header.code === OFS_DELTA) cursor = readOffsetDelta(slice, cursor).offset;
  else if (header.code === REF_DELTA) cursor += 20;
  else if (!TYPE_BY_CODE[header.code]) throw new PackError('unknown object type code');

  const inflated = inflateRecord(slice, cursor, header.size);
  return { code: header.code, payload: inflated.data };
}

export function serializeIndex(packName: string, scan: PackScan): Buffer {
  const doc: PackIndexDocument = {
    entries: scan.entries,
    objectCount: scan.objectCount,
    packName,
    version: PACK_INDEX_VERSION,
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export function parseIndexDocument(payload: Buffer): PackIndexDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new PackError('index is not valid JSON');
  }
  return assertIndexDocument(parsed);
}

export function assertIndexDocument(parsed: unknown): PackIndexDocument {
  if (typeof parsed !== 'object' || parsed === null) throw new PackError('index is not an object');
  const doc = parsed as Partial<PackIndexDocument>;
  if (doc.version !== PACK_INDEX_VERSION) throw new PackError('unsupported index version');
  if (!Array.isArray(doc.entries)) throw new PackError('index entries must be an array');
  for (const entry of doc.entries) {
    if (!isGitObjectType(entry.objectType)) throw new PackError('index entry has invalid type');
  }
  return {
    entries: doc.entries,
    objectCount: doc.objectCount ?? doc.entries.length,
    packName: doc.packName ?? '',
    version: PACK_INDEX_VERSION,
  };
}
