/**
 * 儲存層加密：AES-256-GCM 分塊格式。
 *
 * 功能位置：
 * - parseMasterKey()   : 行 73  — 解析全站主金鑰（base64 / base64url / hex）
 * - deriveFileKey()    : 行 87  — 以檔案路徑 HKDF 衍生每檔子金鑰
 * - encryptBytes()     : 行 120 — 整檔加密成「檔頭 + 多個獨立區塊」，輸出預先配置
 * - readCipherHeader() : 行 155 — 由前 16 位元組解析版面
 * - cipherLengthOf()   : 行 175 — 由版面推算密文總長
 * - cipherRangeFor()   : 行 192 — 明文區間 → 需抓取的密文區間與起始區塊
 * - decryptRange()     : 行 214 — 解密抓回的區塊並切出所求明文
 * - decryptBytes()     : 行 242 — 整檔解密
 *
 * 為什麼要分塊：儲存桶是公開的，所以內容必須加密；但 packfile 的讀取是隨機位移的，
 * 整檔單一密文會讓每次讀一個 git 物件都得下載整個 pack。把明文切成固定大小區塊、
 * 每塊各自帶 nonce 與驗證標籤之後，就能用 HTTP Range 只抓涉及的區塊，
 * 同時每塊都還是經過驗證的（CTR 之類的串流模式做不到這點）。
 *
 * 密文版面：
 *   檔頭 16 位元組：magic(8) | chunkSize(uint32be) | plainSize(uint32be)
 *   之後每塊：nonce(12) | ciphertext(本塊明文長度) | tag(16)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ByteRange } from './ranges.js';

const MAGIC = Buffer.from('ODGENC01', 'utf8');
const MAGIC_BYTES = MAGIC.length;

export const CIPHER_HEADER_BYTES = 16;
export const MASTER_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

const ALGORITHM = 'aes-256-gcm';
const HKDF_INFO_PREFIX = 'onedrive-github/file-key:';
const MAX_PLAIN_BYTES = 0xff_ff_ff_ff;

/** 只描述原因，不回傳金鑰、路徑之外的值，避免把密鑰寫進日誌。 */
export class CryptoError extends Error {
  constructor(reason: string) {
    super(`Storage encryption error: ${reason}`);
    this.name = 'CryptoError';
  }
}

export interface CipherLayout {
  chunkSize: number;
  plainSize: number;
}

export interface RangePlan {
  firstChunk: number;
  range: ByteRange;
}

function decodeKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(trimmed)) {
    return null;
  }
  const decoded = Buffer.from(trimmed, 'base64');
  return decoded.length === MASTER_KEY_BYTES ? decoded : null;
}

export function parseMasterKey(value: string): Buffer {
  const decoded = decodeKey(value);
  if (!decoded) {
    throw new CryptoError('master key must be 32 bytes encoded as base64, base64url or hex');
  }
  return decoded;
}

function assertMasterKey(key: Buffer): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new CryptoError('master key must be exactly 32 bytes');
  }
}

export function deriveFileKey(masterKey: Buffer, path: string): Buffer {
  assertMasterKey(masterKey);
  const info = Buffer.from(`${HKDF_INFO_PREFIX}${path}`, 'utf8');
  const derived = hkdfSync('sha256', masterKey, MAGIC, info, MASTER_KEY_BYTES);
  return Buffer.from(derived);
}

function assertChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new CryptoError('chunk size must be a positive integer');
  }
}

function storedChunkBytes(chunkSize: number): number {
  return NONCE_BYTES + chunkSize + TAG_BYTES;
}

function openChunk(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError('chunk is shorter than its own envelope');
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CryptoError('chunk authentication failed');
  }
}

export function encryptBytes(
  key: Buffer,
  plain: Buffer,
  chunkSize: number = DEFAULT_CHUNK_BYTES,
): Buffer {
  assertMasterKey(key);
  assertChunkSize(chunkSize);
  if (plain.length > MAX_PLAIN_BYTES) {
    throw new CryptoError('plaintext exceeds the addressable size of this format');
  }

  const layout: CipherLayout = { chunkSize, plainSize: plain.length };
  const out = Buffer.alloc(cipherLengthOf(layout));
  MAGIC.copy(out, 0);
  out.writeUInt32BE(chunkSize, MAGIC_BYTES);
  out.writeUInt32BE(plain.length, MAGIC_BYTES + 4);

  // 逐塊密封並寫進輸出緩衝的對應偏移；相較收集 parts 再 concat，
  // 峰值佔用從約 3 倍檔案大小降到 2 倍加單一區塊。
  let wpos = CIPHER_HEADER_BYTES;
  for (let offset = 0; offset < plain.length; offset += chunkSize) {
    const chunk = plain.subarray(offset, Math.min(offset + chunkSize, plain.length));
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const body = cipher.update(chunk);
    cipher.final(); // GCM 的 final 不產出密文，認證標籤另取
    const tag = cipher.getAuthTag();
    nonce.copy(out, wpos);
    body.copy(out, wpos + NONCE_BYTES);
    tag.copy(out, wpos + NONCE_BYTES + body.length);
    wpos += NONCE_BYTES + body.length + TAG_BYTES;
  }
  return out;
}

export function readCipherHeader(head: Buffer): CipherLayout {
  if (head.length < CIPHER_HEADER_BYTES) {
    throw new CryptoError('ciphertext is too short to contain a header');
  }
  if (!head.subarray(0, MAGIC_BYTES).equals(MAGIC)) {
    throw new CryptoError('ciphertext header magic does not match');
  }
  const chunkSize = head.readUInt32BE(MAGIC_BYTES);
  const plainSize = head.readUInt32BE(MAGIC_BYTES + 4);
  if (chunkSize <= 0) {
    throw new CryptoError('ciphertext header declares an invalid chunk size');
  }
  return { chunkSize, plainSize };
}

function chunkCount(layout: CipherLayout): number {
  return Math.ceil(layout.plainSize / layout.chunkSize);
}

/** 最後一塊的明文通常短於 chunkSize，所以總長不是塊數乘以固定值。 */
export function cipherLengthOf(layout: CipherLayout): number {
  const full = chunkCount(layout);
  if (full === 0) {
    return CIPHER_HEADER_BYTES;
  }
  const lastPlain = layout.plainSize - (full - 1) * layout.chunkSize;
  return (
    CIPHER_HEADER_BYTES +
    (full - 1) * storedChunkBytes(layout.chunkSize) +
    storedChunkBytes(lastPlain)
  );
}

function chunkStart(layout: CipherLayout, index: number): number {
  return CIPHER_HEADER_BYTES + index * storedChunkBytes(layout.chunkSize);
}

export function cipherRangeFor(layout: CipherLayout, plain: ByteRange): RangePlan {
  if (!Number.isInteger(plain.start) || !Number.isInteger(plain.end)) {
    throw new CryptoError('plaintext range must use integer offsets');
  }
  if (plain.start < 0 || plain.end < plain.start) {
    throw new CryptoError('plaintext range is not a forward interval');
  }
  if (plain.end >= layout.plainSize) {
    throw new CryptoError('plaintext range exceeds the stored size');
  }

  const firstChunk = Math.floor(plain.start / layout.chunkSize);
  const lastChunk = Math.floor(plain.end / layout.chunkSize);
  const start = chunkStart(layout, firstChunk);
  const end = Math.min(chunkStart(layout, lastChunk + 1), cipherLengthOf(layout)) - 1;
  return { firstChunk, range: { start, end } };
}

/**
 * slice 必須正好是 cipherRangeFor 規劃出的那段位元組。長度不符時拋錯而不是盡力解析，
 * 否則一個被截斷的回應會被解成錯位的明文。
 */
export function decryptRange(
  key: Buffer,
  layout: CipherLayout,
  plan: RangePlan,
  slice: Buffer,
  plain: ByteRange,
): Buffer {
  assertMasterKey(key);
  if (slice.length !== plan.range.end - plan.range.start + 1) {
    throw new CryptoError('ciphertext slice length does not match the planned range');
  }

  const stored = storedChunkBytes(layout.chunkSize);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < slice.length; offset += stored) {
    parts.push(openChunk(key, slice.subarray(offset, Math.min(offset + stored, slice.length))));
  }

  const decoded = Buffer.concat(parts);
  const base = plan.firstChunk * layout.chunkSize;
  const from = plain.start - base;
  const to = plain.end - base + 1;
  if (from < 0 || to > decoded.length) {
    throw new CryptoError('decrypted chunks do not cover the requested range');
  }
  return decoded.subarray(from, to);
}

export function decryptBytes(key: Buffer, cipher: Buffer): Buffer {
  const layout = readCipherHeader(cipher);
  if (cipher.length !== cipherLengthOf(layout)) {
    throw new CryptoError('ciphertext length does not match its header');
  }
  if (layout.plainSize === 0) {
    return Buffer.alloc(0);
  }
  const plain: ByteRange = { start: 0, end: layout.plainSize - 1 };
  const plan = cipherRangeFor(layout, plain);
  return decryptRange(key, layout, plan, cipher.subarray(plan.range.start), plain);
}
