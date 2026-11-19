/**
 * Git 物件原語測試：oid 計算、loose 物件編解碼、物件型別守門。
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import {
  GIT_OBJECT_TYPES,
  GitObjectError,
  decodeLoose,
  encodeLoose,
  isGitObjectType,
  objectHeader,
  oidOf,
} from '@/git/object.js';
import { sha1Oid } from '../helpers/pack.js';

describe('物件型別', () => {
  it('恰好支援四種 git 物件型別', () => {
    expect([...GIT_OBJECT_TYPES]).toEqual(['commit', 'tree', 'blob', 'tag']);
  });

  it('接受合法型別', () => {
    for (const type of GIT_OBJECT_TYPES) expect(isGitObjectType(type)).toBe(true);
  });

  it.each(['ofs_delta', 'ref_delta', 'COMMIT', '', 'object'])('拒絕非法型別 %s', (value) => {
    expect(isGitObjectType(value)).toBe(false);
  });
});

describe('oid 計算', () => {
  it('空 blob 的 oid 與 git 官方值一致', () => {
    expect(oidOf('blob', Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('hello blob 的 oid 與 git 官方值一致', () => {
    expect(oidOf('blob', Buffer.from('hello\n', 'utf8'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });

  it('與獨立實作的雜湊相同', () => {
    const content = Buffer.from('arbitrary payload', 'utf8');
    expect(oidOf('tree', content)).toBe(sha1Oid('tree', content));
  });

  it('標頭格式為 `<type> <size>\\0`', () => {
    expect(objectHeader('commit', 12).toString('utf8')).toBe('commit 12\0');
  });

  it('內容不同則 oid 不同', () => {
    expect(oidOf('blob', Buffer.from('a'))).not.toBe(oidOf('blob', Buffer.from('b')));
  });

  it('型別不同則 oid 不同', () => {
    const content = Buffer.from('same bytes');
    expect(oidOf('blob', content)).not.toBe(oidOf('tree', content));
  });
});

describe('loose 物件編解碼', () => {
  it('編碼後可被 decodeLoose 還原', () => {
    const content = Buffer.from('round trip', 'utf8');
    const encoded = encodeLoose('blob', content);
    const decoded = decodeLoose(encoded);
    expect(decoded.type).toBe('blob');
    expect(decoded.content.toString('utf8')).toBe('round trip');
  });

  it('編碼結果為 zlib 壓縮且不含明文標頭', () => {
    const encoded = encodeLoose('blob', Buffer.from('plain text here'));
    expect(encoded.subarray(0, 2).toString('hex')).toBe('789c');
  });

  it('解碼回報 oid 以便驗證完整性', () => {
    const content = Buffer.from('hello\n', 'utf8');
    expect(decodeLoose(encodeLoose('blob', content)).oid).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });

  it('解碼標示的大小與實際內容不符時拋錯', () => {
    const corrupted = deflateSync(Buffer.concat([Buffer.from('blob 99\0'), Buffer.from('short')]));
    expect(() => decodeLoose(corrupted)).toThrow(GitObjectError);
  });

  it('解碼缺少 NUL 分隔的標頭時拋錯', () => {
    expect(() => decodeLoose(deflateSync(Buffer.from('blob 5 hello')))).toThrow(GitObjectError);
  });

  it('解碼未知型別時拋錯', () => {
    const payload = deflateSync(Buffer.concat([Buffer.from('widget 2\0'), Buffer.from('ab')]));
    expect(() => decodeLoose(payload)).toThrow(GitObjectError);
  });

  it('解碼非 zlib 資料時拋 GitObjectError 而非底層錯誤', () => {
    expect(() => decodeLoose(Buffer.from('not compressed at all'))).toThrow(GitObjectError);
  });

  it('空內容也能往返', () => {
    const decoded = decodeLoose(encodeLoose('blob', Buffer.alloc(0)));
    expect(decoded.content.length).toBe(0);
    expect(decoded.type).toBe('blob');
  });
});
