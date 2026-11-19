/**
 * pkt-line 編解碼測試：長度前綴、flush/delim 封包、side-band 與邊界守門。
 */
import { describe, expect, it } from 'vitest';

import {
  DELIM_PKT,
  FLUSH_PKT,
  MAX_PKT_PAYLOAD,
  PktLineError,
  encodePkt,
  encodeText,
  parsePktLines,
  sideBand,
} from '@/git/pktline.js';

describe('編碼', () => {
  it('以 4 位元組十六進位長度為前綴', () => {
    expect(encodeText('a').toString('utf8')).toBe('0005a');
  });

  it('長度含前綴本身', () => {
    expect(encodePkt(Buffer.from('hello')).toString('utf8')).toBe('0009hello');
  });

  it('長度以小寫十六進位表示', () => {
    expect(encodeText('x'.repeat(251)).subarray(0, 4).toString('utf8')).toBe('00ff');
  });

  it('flush 封包為 0000', () => {
    expect(FLUSH_PKT.toString('utf8')).toBe('0000');
  });

  it('delim 封包為 0001', () => {
    expect(DELIM_PKT.toString('utf8')).toBe('0001');
  });

  it('空內容編為合法封包而非 flush', () => {
    expect(encodePkt(Buffer.alloc(0)).toString('utf8')).toBe('0004');
  });

  it('超過上限的內容拋錯', () => {
    expect(() => encodePkt(Buffer.alloc(MAX_PKT_PAYLOAD + 1))).toThrow(PktLineError);
  });

  it('剛好等於上限的內容可編碼', () => {
    expect(encodePkt(Buffer.alloc(MAX_PKT_PAYLOAD)).length).toBe(MAX_PKT_PAYLOAD + 4);
  });
});

describe('解析', () => {
  it('解析單一資料封包', () => {
    const packets = parsePktLines(encodeText('want abc\n'));
    expect(packets).toHaveLength(1);
    expect(packets[0]?.kind).toBe('data');
    expect(packets[0]?.payload?.toString('utf8')).toBe('want abc\n');
  });

  it('解析連續封包並保留順序', () => {
    const stream = Buffer.concat([encodeText('one'), encodeText('two'), FLUSH_PKT]);
    const packets = parsePktLines(stream);
    expect(packets.map((p) => p.payload?.toString('utf8') ?? p.kind)).toEqual([
      'one',
      'two',
      'flush',
    ]);
  });

  it('區分 flush 與 delim', () => {
    const packets = parsePktLines(Buffer.concat([DELIM_PKT, FLUSH_PKT]));
    expect(packets.map((p) => p.kind)).toEqual(['delim', 'flush']);
  });

  it('空輸入回空陣列', () => {
    expect(parsePktLines(Buffer.alloc(0))).toEqual([]);
  });

  it('長度標頭不足 4 位元組時拋錯', () => {
    expect(() => parsePktLines(Buffer.from('001'))).toThrow(PktLineError);
  });

  it('長度標頭非十六進位時拋錯', () => {
    expect(() => parsePktLines(Buffer.from('zzzzdata'))).toThrow(PktLineError);
  });

  it('宣告長度超過實際資料時拋錯', () => {
    expect(() => parsePktLines(Buffer.from('0020short'))).toThrow(PktLineError);
  });

  it('宣告長度為 0002 等保留值時拋錯', () => {
    expect(() => parsePktLines(Buffer.from('0002'))).toThrow(PktLineError);
  });

  it('宣告長度為 3 等不合法短值時拋錯', () => {
    expect(() => parsePktLines(Buffer.from('0003'))).toThrow(PktLineError);
  });

  it('二進位內容不被破壞', () => {
    const binary = Buffer.from([0x00, 0xff, 0x0a, 0x7f, 0x80]);
    expect(parsePktLines(encodePkt(binary))[0]?.payload?.equals(binary)).toBe(true);
  });
});

describe('side-band', () => {
  it('頻道 1 為 pack 資料', () => {
    const framed = sideBand(1, Buffer.from('pack'));
    expect(framed.toString('utf8')).toBe('0009\u0001pack');
  });

  it('頻道 2 為進度訊息', () => {
    expect(sideBand(2, Buffer.from('msg')).subarray(4, 5)[0]).toBe(2);
  });

  it('頻道 3 為錯誤訊息', () => {
    expect(sideBand(3, Buffer.from('err')).subarray(4, 5)[0]).toBe(3);
  });

  it.each([0, 4, -1])('非法頻道 %s 拋錯', (channel) => {
    expect(() => sideBand(channel, Buffer.from('x'))).toThrow(PktLineError);
  });

  it('side-band 內容上限較小以容納頻道位元組', () => {
    expect(() => sideBand(1, Buffer.alloc(MAX_PKT_PAYLOAD))).toThrow(PktLineError);
  });

  it('頻道位元組扣掉後恰好等於上限的內容可封裝', () => {
    const framed = sideBand(2, Buffer.alloc(MAX_PKT_PAYLOAD - 1, 0x61));
    expect(framed.length).toBe(MAX_PKT_PAYLOAD + 4);
    expect(framed.subarray(0, 4).toString('ascii')).toBe('fff0');
    expect(framed[4]).toBe(2);
    expect(framed[5]).toBe(0x61);
  });

  it('空內容編為僅含頻道位元組的封包', () => {
    expect(sideBand(1, Buffer.alloc(0)).toString('latin1')).toBe('0005\u0001');
  });
});
