/**
 * commit 與 tree 的解析與編碼。
 *
 * - parseCommit：取出 tree、parents 與訊息本文
 * - parseTree / encodeTree：tree 項目的二進位格式往返
 */
import { oidOf } from './object.js';

const OID_HEX_LENGTH = 40;
const OID_BYTES = 20;
const OID_PATTERN = /^[0-9a-f]{40}$/;

export class GitParseError extends Error {
  constructor(reason: string) {
    super(`Cannot parse git object: ${reason}`);
    this.name = 'GitParseError';
  }
}

export interface CommitObject {
  message: string;
  parents: string[];
  tree: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function normalizeOid(value: string | undefined, field: string): string {
  const oid = (value ?? '').toLowerCase();
  if (!OID_PATTERN.test(oid)) throw new GitParseError(`${field} is not a valid object id`);
  return oid;
}

export function parseCommit(payload: Buffer): CommitObject {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);

  let tree: string | null = null;
  const parents: string[] = [];

  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = normalizeOid(line.slice(5).trim(), 'tree');
    else if (line.startsWith('parent ')) parents.push(normalizeOid(line.slice(7).trim(), 'parent'));
  }

  if (tree === null) throw new GitParseError('commit has no tree');
  return { message, parents, tree };
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let cursor = 0;

  while (cursor < payload.length) {
    const nul = payload.indexOf(0, cursor);
    if (nul < 0) throw new GitParseError('tree entry is missing NUL separator');

    const head = payload.subarray(cursor, nul).toString('utf8');
    const space = head.indexOf(' ');
    if (space <= 0 || space === head.length - 1) {
      throw new GitParseError('tree entry has no mode separator');
    }

    const end = nul + 1 + OID_BYTES;
    if (end > payload.length) throw new GitParseError('tree entry is truncated');

    entries.push({
      mode: head.slice(0, space),
      name: head.slice(space + 1),
      oid: payload.subarray(nul + 1, end).toString('hex'),
    });
    cursor = end;
  }

  return entries;
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Buffer.concat(
    sorted.map((entry) =>
      Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
        Buffer.from(normalizeOid(entry.oid, 'entry').slice(0, OID_HEX_LENGTH), 'hex'),
      ]),
    ),
  );
}

export function treeOid(entries: readonly TreeEntry[]): string {
  return oidOf('tree', encodeTree(entries));
}
