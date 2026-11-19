/**
 * 測試用 packfile 建構器（獨立實作 sha1 與編碼，不依賴受測模組，避免套套邏輯）。
 *
 * - PACK_TYPE_CODES / PackInput：pack 物件型別碼與輸入描述
 * - sha1Oid：以 `<type> <size>\0` 標頭計算物件 id
 * - encodeObjectHeader / encodeOffset：pack 可變長度編碼
 * - makeDelta：產生含 copy + insert 指令的 delta 位元組
 * - buildPack：組出合法 packfile（含 sha1 trailer）並回報每個物件的位移
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const PACK_TYPE_CODES = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  ofs_delta: 6,
  ref_delta: 7,
} as const;

export type PackInputType = keyof typeof PACK_TYPE_CODES;

export interface PackInput {
  type: PackInputType;
  content: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

export function sha1Oid(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

export function encodeObjectHeader(code: number, size: number): Buffer {
  const out: number[] = [];
  let byte = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

export function encodeOffset(value: number): Buffer {
  const bytes = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

export function encodeVarSize(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

export function makeDelta(base: Buffer, result: Buffer): Buffer {
  const out: number[] = [...encodeVarSize(base.length), ...encodeVarSize(result.length)];
  const limit = Math.min(base.length, result.length, 0xff);
  let copied = 0;
  while (copied < limit && base[copied] === result[copied]) copied += 1;
  if (copied > 0) {
    out.push(0x80 | 0x10, copied & 0xff);
  }
  let pos = copied;
  while (pos < result.length) {
    const chunk = Math.min(127, result.length - pos);
    out.push(chunk);
    for (let i = 0; i < chunk; i += 1) out.push(result[pos + i] ?? 0);
    pos += chunk;
  }
  return Buffer.from(out);
}

export interface BuiltPack {
  pack: Buffer;
  offsets: number[];
}

export function buildPack(objects: PackInput[], objectCount?: number): BuiltPack {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objectCount ?? objects.length, 8);

  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let cursor = header.length;

  for (const obj of objects) {
    offsets.push(cursor);
    const pieces: Buffer[] = [encodeObjectHeader(PACK_TYPE_CODES[obj.type], obj.content.length)];
    if (obj.type === 'ofs_delta') {
      pieces.push(encodeOffset(cursor - (obj.baseOffset ?? 0)));
    } else if (obj.type === 'ref_delta') {
      pieces.push(Buffer.from(obj.baseOid ?? '', 'hex'));
    }
    pieces.push(deflateSync(obj.content));
    const record = Buffer.concat(pieces);
    parts.push(record);
    cursor += record.length;
  }

  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return { pack: Buffer.concat([body, trailer]), offsets };
}
