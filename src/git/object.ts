/**
 * Git 物件原語。
 *
 * - GIT_OBJECT_TYPES / isGitObjectType：合法物件型別與守門
 * - objectHeader / oidOf：`<type> <size>\0` 標頭與 sha1 物件 id
 * - encodeLoose / decodeLoose：loose 物件 zlib 編解碼
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const GIT_OBJECT_TYPES = ['commit', 'tree', 'blob', 'tag'] as const;

export type GitObjectType = (typeof GIT_OBJECT_TYPES)[number];

export class GitObjectError extends Error {
  constructor(reason: string) {
    super(`Invalid git object: ${reason}`);
    this.name = 'GitObjectError';
  }
}

export function isGitObjectType(value: unknown): value is GitObjectType {
  return typeof value === 'string' && (GIT_OBJECT_TYPES as readonly string[]).includes(value);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function oidOf(type: GitObjectType, content: Buffer): string {
  return createHash('sha1').update(objectHeader(type, content.length)).update(content).digest('hex');
}

export function encodeLoose(type: GitObjectType, content: Buffer): Buffer {
  return deflateSync(Buffer.concat([objectHeader(type, content.length), content]));
}

export interface LooseObject {
  content: Buffer;
  oid: string;
  type: GitObjectType;
}

export function decodeLoose(payload: Buffer): LooseObject {
  let raw: Buffer;
  try {
    raw = inflateSync(payload);
  } catch {
    throw new GitObjectError('payload is not zlib data');
  }

  const nul = raw.indexOf(0);
  if (nul < 0) throw new GitObjectError('header is missing NUL separator');

  const [type, size] = raw.subarray(0, nul).toString('utf8').split(' ');
  if (!isGitObjectType(type)) throw new GitObjectError('unknown object type');

  const declared = Number(size);
  const content = raw.subarray(nul + 1);
  if (!Number.isInteger(declared) || declared !== content.length) {
    throw new GitObjectError('declared size does not match content');
  }

  return { content, oid: oidOf(type, content), type };
}
