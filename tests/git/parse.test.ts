/**
 * commit 與 tree 的解析契約。
 */
import { describe, expect, it } from 'vitest';

import { parseCommit, parseTree, GitParseError, encodeTree } from '@/git/parse.js';
import { oidOf } from '@/git/object.js';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

function commitBody(lines: string[], message = 'init\n'): Buffer {
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

describe('parseCommit', () => {
  it('解析 tree 與單一 parent', () => {
    const payload = commitBody([
      `tree ${OID_A}`,
      `parent ${OID_B}`,
      'author A <a@example.com> 1700000000 +0000',
      'committer A <a@example.com> 1700000000 +0000',
    ]);

    const commit = parseCommit(payload);

    expect(commit.tree).toBe(OID_A);
    expect(commit.parents).toEqual([OID_B]);
  });

  it('解析合併提交的多個 parent 並保持順序', () => {
    const payload = commitBody([`tree ${OID_A}`, `parent ${OID_B}`, `parent ${OID_C}`]);

    expect(parseCommit(payload).parents).toEqual([OID_B, OID_C]);
  });

  it('根提交沒有 parent 時回空陣列', () => {
    expect(parseCommit(commitBody([`tree ${OID_A}`])).parents).toEqual([]);
  });

  it('保留訊息本文', () => {
    const payload = commitBody([`tree ${OID_A}`], 'first line\n\nbody\n');

    expect(parseCommit(payload).message).toBe('first line\n\nbody\n');
  });

  it('缺少 tree 時拋錯', () => {
    expect(() => parseCommit(commitBody(['parent ' + OID_B]))).toThrow(GitParseError);
  });

  it('tree oid 長度不符時拋錯', () => {
    expect(() => parseCommit(commitBody(['tree abc']))).toThrow(GitParseError);
  });

  it('oid 一律正規化為小寫', () => {
    const payload = commitBody([`tree ${'A'.repeat(40)}`]);

    expect(parseCommit(payload).tree).toBe(OID_A);
  });
});

describe('parseTree', () => {
  function entry(mode: string, name: string, oid: string): Buffer {
    return Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(oid, 'hex')]);
  }

  it('解析單一 blob 項目', () => {
    const entries = parseTree(entry('100644', 'readme.md', OID_A));

    expect(entries).toEqual([{ mode: '100644', name: 'readme.md', oid: OID_A }]);
  });

  it('解析多個項目並保持順序', () => {
    const payload = Buffer.concat([
      entry('100644', 'a.txt', OID_A),
      entry('40000', 'lib', OID_B),
      entry('100755', 'run.sh', OID_C),
    ]);

    expect(parseTree(payload).map((item) => item.name)).toEqual(['a.txt', 'lib', 'run.sh']);
  });

  it('目錄項目的 mode 可辨識為子樹', () => {
    const entries = parseTree(entry('40000', 'lib', OID_B));

    expect(entries[0]?.mode).toBe('40000');
  });

  it('空樹回空陣列', () => {
    expect(parseTree(Buffer.alloc(0))).toEqual([]);
  });

  it('項目被截斷時拋錯', () => {
    const payload = entry('100644', 'a.txt', OID_A).subarray(0, 20);

    expect(() => parseTree(payload)).toThrow(GitParseError);
  });

  it('缺少 NUL 分隔時拋錯', () => {
    expect(() => parseTree(Buffer.from('100644 a.txt', 'utf8'))).toThrow(GitParseError);
  });

  it('mode 與名稱之間缺少空白時拋錯', () => {
    const payload = Buffer.concat([Buffer.from('100644a.txt\0', 'utf8'), Buffer.from(OID_A, 'hex')]);

    expect(() => parseTree(payload)).toThrow(GitParseError);
  });
});

describe('encodeTree', () => {
  it('編碼後可被 parseTree 還原', () => {
    const entries = [
      { mode: '100644', name: 'a.txt', oid: OID_A },
      { mode: '40000', name: 'lib', oid: OID_B },
    ];

    expect(parseTree(encodeTree(entries))).toEqual(entries);
  });

  it('項目依 git 的名稱排序規則輸出', () => {
    const entries = [
      { mode: '100644', name: 'b.txt', oid: OID_B },
      { mode: '100644', name: 'a.txt', oid: OID_A },
    ];

    expect(parseTree(encodeTree(entries)).map((item) => item.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('編碼空樹的 oid 等於 git 的空樹常數', () => {
    expect(oidOf('tree', encodeTree([]))).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });
});
