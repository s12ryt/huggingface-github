/**
 * packfile 掃描測試：標頭驗證、物件逐筆位移、delta 鏈展平（E+2）、索引序列化（E+1）。
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import {
  PackError,
  PACK_INDEX_VERSION,
  parseIndexDocument,
  scanPack,
  serializeIndex,
} from '@/git/pack.js';
import { buildPack, makeDelta, sha1Oid, type PackInput } from '../helpers/pack.js';

const blobA = Buffer.from('alpha content for testing', 'utf8');
const blobB = Buffer.from('alpha content for testing, extended tail', 'utf8');
const blobC = Buffer.from('alpha content for testing, extended tail, third layer', 'utf8');

const oidA = sha1Oid('blob', blobA);
const oidB = sha1Oid('blob', blobB);
const oidC = sha1Oid('blob', blobC);

function plainPack() {
  return buildPack([
    { type: 'blob', content: blobA },
    { type: 'commit', content: Buffer.from('tree 0\n', 'utf8') },
  ]);
}

describe('pack 標頭', () => {
  it('拒絕錯誤的魔術字', () => {
    const { pack } = plainPack();
    pack.write('PACX', 0, 'ascii');
    expect(() => scanPack(pack)).toThrow(PackError);
  });

  it('拒絕不支援的版本', () => {
    const { pack } = plainPack();
    pack.writeUInt32BE(9, 4);
    expect(() => scanPack(pack)).toThrow(PackError);
  });

  it('拒絕過短的緩衝', () => {
    expect(() => scanPack(Buffer.alloc(8))).toThrow(PackError);
  });

  it('宣告物件數與實際不符時拋錯', () => {
    const { pack } = buildPack([{ type: 'blob', content: blobA }], 5);
    expect(() => scanPack(pack)).toThrow(PackError);
  });
});

describe('非 delta 物件', () => {
  it('回報每個物件的 oid、型別與位移', () => {
    const { pack, offsets } = plainPack();
    const entries = scanPack(pack).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.oid).toBe(oidA);
    expect(entries[0]?.type).toBe('blob');
    expect(entries[0]?.packOffset).toBe(offsets[0]);
    expect(entries[1]?.type).toBe('commit');
  });

  it('回報還原後大小與儲存大小', () => {
    const entry = scanPack(plainPack().pack).entries[0];
    expect(entry?.inflatedSize).toBe(blobA.length);
    expect(entry?.storedSize).toBeGreaterThan(0);
  });

  it('非 delta 物件的 deltaChain 為空陣列', () => {
    expect(scanPack(plainPack().pack).entries[0]?.deltaChain).toEqual([]);
  });

  it('回報 pack 內的物件總數', () => {
    expect(scanPack(plainPack().pack).objectCount).toBe(2);
  });
});

describe('ofs_delta 展平（E+2）', () => {
  function chainPack() {
    const first: PackInput = { type: 'blob', content: blobA };
    const probe = buildPack([first]);
    const baseOffset = probe.offsets[0] ?? 0;
    const second: PackInput = {
      type: 'ofs_delta',
      content: makeDelta(blobA, blobB),
      baseOffset,
    };
    const twoLayer = buildPack([first, second]);
    const third: PackInput = {
      type: 'ofs_delta',
      content: makeDelta(blobB, blobC),
      baseOffset: twoLayer.offsets[1] ?? 0,
    };
    return buildPack([first, second, third]);
  }

  it('解析出 delta 物件還原後的最終型別', () => {
    const entries = scanPack(chainPack().pack).entries;
    expect(entries[1]?.type).toBe('blob');
    expect(entries[2]?.type).toBe('blob');
  });

  it('計算出 delta 物件的真實 oid', () => {
    const entries = scanPack(chainPack().pack).entries;
    expect(entries[1]?.oid).toBe(oidB);
    expect(entries[2]?.oid).toBe(oidC);
  });

  it('單層 delta 的鏈為一個 base oid', () => {
    expect(scanPack(chainPack().pack).entries[1]?.deltaChain).toEqual([oidA]);
  });

  it('兩層 delta 的鏈展平為由近到遠的 oid 清單', () => {
    expect(scanPack(chainPack().pack).entries[2]?.deltaChain).toEqual([oidB, oidA]);
  });

  it('展平後的鏈不含遞迴結構', () => {
    const chain = scanPack(chainPack().pack).entries[2]?.deltaChain ?? [];
    for (const oid of chain) expect(typeof oid).toBe('string');
  });

  it('回報還原後大小而非 delta 指令大小', () => {
    const entry = scanPack(chainPack().pack).entries[2];
    expect(entry?.inflatedSize).toBe(blobC.length);
  });

  it('base 位移指向 pack 之外時拋錯', () => {
    const bad = buildPack([
      { type: 'blob', content: blobA },
      { type: 'ofs_delta', content: makeDelta(blobA, blobB), baseOffset: -500 },
    ]);
    expect(() => scanPack(bad.pack)).toThrow(PackError);
  });
});

describe('ref_delta 展平', () => {
  it('以 oid 解析 base 並展平', () => {
    const { pack } = buildPack([
      { type: 'blob', content: blobA },
      { type: 'ref_delta', content: makeDelta(blobA, blobB), baseOid: oidA },
    ]);
    const entries = scanPack(pack).entries;
    expect(entries[1]?.oid).toBe(oidB);
    expect(entries[1]?.deltaChain).toEqual([oidA]);
  });

  it('base oid 不在同一 pack 內時拋錯', () => {
    const { pack } = buildPack([
      { type: 'ref_delta', content: makeDelta(blobA, blobB), baseOid: 'f'.repeat(40) },
    ]);
    expect(() => scanPack(pack)).toThrow(PackError);
  });

  it('base 出現在 delta 之後也能解析（二次掃描）', () => {
    const { pack } = buildPack([
      { type: 'ref_delta', content: makeDelta(blobA, blobB), baseOid: oidA },
      { type: 'blob', content: blobA },
    ]);
    const entries = scanPack(pack).entries;
    expect(entries[0]?.oid).toBe(oidB);
    expect(entries[0]?.deltaChain).toEqual([oidA]);
  });
});

describe('索引序列化（E+1 索引雙存）', () => {
  it('序列化為帶版本的 JSON 文件', () => {
    const scan = scanPack(plainPack().pack);
    const doc = parseIndexDocument(serializeIndex('pack-1.pack', scan));
    expect(doc.version).toBe(PACK_INDEX_VERSION);
    expect(doc.packName).toBe('pack-1.pack');
    expect(doc.objectCount).toBe(2);
  });

  it('序列化內容可往返還原所有欄位', () => {
    const scan = scanPack(plainPack().pack);
    const doc = parseIndexDocument(serializeIndex('pack-1.pack', scan));
    expect(doc.entries[0]).toEqual(scan.entries[0]);
  });

  it('序列化輸出為人類可讀的縮排 JSON', () => {
    const text = serializeIndex('pack-1.pack', scanPack(plainPack().pack)).toString('utf8');
    expect(text).toContain('\n  ');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('版本不符時拋錯，避免誤讀舊格式', () => {
    const payload = Buffer.from(JSON.stringify({ version: 0, entries: [] }), 'utf8');
    expect(() => parseIndexDocument(payload)).toThrow(PackError);
  });

  it('壞 JSON 拋 PackError 而非底層錯誤', () => {
    expect(() => parseIndexDocument(Buffer.from('{ not json', 'utf8'))).toThrow(PackError);
  });

  it('entries 非陣列時拋錯', () => {
    const payload = Buffer.from(
      JSON.stringify({ version: PACK_INDEX_VERSION, entries: 'nope' }),
      'utf8',
    );
    expect(() => parseIndexDocument(payload)).toThrow(PackError);
  });
});

describe('zlib 損壞', () => {
  it('物件內容無法解壓時拋 PackError', () => {
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1, 8);
    const body = Buffer.concat([header, Buffer.from([0x33]), Buffer.from('garbage bytes')]);
    expect(() => scanPack(Buffer.concat([body, Buffer.alloc(20)]))).toThrow(PackError);
  });

  it('合法 zlib 但大小宣告不符時拋 PackError', () => {
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1, 8);
    const objHeader = Buffer.from([0x3a]); // blob, size=10
    const payload = deflateSync(Buffer.from('abc'));
    expect(() =>
      scanPack(Buffer.concat([header, objHeader, payload, Buffer.alloc(20)])),
    ).toThrow(PackError);
  });
});
