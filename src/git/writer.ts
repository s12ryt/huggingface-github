/**
 * packfile 產出與可達物件走訪。
 *
 * - collectReachable：由 want 走訪 commit/tree/blob，並排除 have 已持有的部分
 * - buildPackFile：把物件清單寫成 version 2 packfile（全部以非 delta 形式儲存）
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { parseCommit, parseTree } from './parse.js';
import { objectHeader, type GitObjectType } from './object.js';
import { PACK_SIGNATURE, PACK_VERSION } from './pack.js';
import type { ObjectReader } from './reader.js';

const TYPE_CODES: Record<GitObjectType, number> = { blob: 3, commit: 1, tag: 4, tree: 2 };

function encodeHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

async function walkTree(
  reader: ObjectReader,
  oid: string,
  seen: Set<string>,
  skip: Set<string>,
): Promise<void> {
  if (seen.has(oid) || skip.has(oid)) return;
  const object = await reader.read(oid);
  if (object === null) return;
  seen.add(oid);
  if (object.type !== 'tree') return;

  for (const entry of parseTree(object.content)) {
    await walkTree(reader, entry.oid, seen, skip);
  }
}

async function walkExcluded(reader: ObjectReader, oid: string, skip: Set<string>): Promise<void> {
  if (skip.has(oid)) return;
  const object = await reader.read(oid);
  if (object === null) return;
  skip.add(oid);

  if (object.type === 'commit') {
    const commit = parseCommit(object.content);
    await walkExcluded(reader, commit.tree, skip);
    for (const parent of commit.parents) await walkExcluded(reader, parent, skip);
    return;
  }
  if (object.type === 'tree') {
    for (const entry of parseTree(object.content)) await walkExcluded(reader, entry.oid, skip);
  }
}

export async function collectReachable(
  reader: ObjectReader,
  wants: readonly string[],
  haves: readonly string[],
): Promise<Set<string>> {
  const skip = new Set<string>();
  for (const have of haves) await walkExcluded(reader, have, skip);

  const seen = new Set<string>();
  const queue = [...wants];

  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid) || skip.has(oid)) continue;
    const object = await reader.read(oid);
    if (object === null) continue;

    if (object.type !== 'commit') {
      await walkTree(reader, oid, seen, skip);
      continue;
    }

    seen.add(oid);
    const commit = parseCommit(object.content);
    await walkTree(reader, commit.tree, seen, skip);
    for (const parent of commit.parents) queue.push(parent);
  }

  return seen;
}

export async function buildPackFile(
  reader: ObjectReader,
  oids: Iterable<string>,
): Promise<Buffer> {
  const objects = await reader.readMany([...oids]);

  const head = Buffer.alloc(12);
  head.write(PACK_SIGNATURE, 0, 'ascii');
  head.writeUInt32BE(PACK_VERSION, 4);
  // 標頭宣告的數量必須等於實際寫出的物件數，否則 pack 無法被解析。
  head.writeUInt32BE(objects.length, 8);

  const chunks: Buffer[] = [head];
  for (const object of objects) {
    chunks.push(encodeHeader(TYPE_CODES[object.type], object.content.length));
    chunks.push(deflateSync(object.content));
  }

  // 雜湊以串流方式對各塊累計，之後單次串接；省掉先合成 body 的整份複製。
  const hash = createHash('sha1');
  for (const chunk of chunks) hash.update(chunk);
  return Buffer.concat([...chunks, hash.digest()]);
}

export function looseSize(type: GitObjectType, content: Buffer): number {
  return objectHeader(type, content.length).length + content.length;
}
