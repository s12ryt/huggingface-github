import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CIPHER_HEADER_BYTES,
  CryptoError,
  DEFAULT_CHUNK_BYTES,
  MASTER_KEY_BYTES,
  cipherLengthOf,
  cipherRangeFor,
  decryptBytes,
  decryptRange,
  deriveFileKey,
  encryptBytes,
  parseMasterKey,
  readCipherHeader,
} from '@/storage/crypto.js';

const MASTER = randomBytes(MASTER_KEY_BYTES);

function keyFor(path: string): Buffer {
  return deriveFileKey(MASTER, path);
}

describe('主金鑰解析', () => {
  it('接受 base64 編碼的 32 位元組金鑰', () => {
    const key = parseMasterKey(MASTER.toString('base64'));
    expect(key.equals(MASTER)).toBe(true);
  });

  it('接受 base64url 編碼', () => {
    const key = parseMasterKey(MASTER.toString('base64url'));
    expect(key.equals(MASTER)).toBe(true);
  });

  it('接受 64 字元的十六進位編碼', () => {
    const key = parseMasterKey(MASTER.toString('hex'));
    expect(key.equals(MASTER)).toBe(true);
  });

  it.each([
    ['空字串', ''],
    ['太短', randomBytes(16).toString('base64')],
    ['太長', randomBytes(48).toString('base64')],
    ['不是合法編碼', '這不是金鑰'],
  ])('拒絕%s', (_label, value) => {
    expect(() => parseMasterKey(value)).toThrow(CryptoError);
  });

  it('金鑰不合法時的錯誤訊息不得含金鑰內容', () => {
    const bad = randomBytes(16).toString('base64');
    try {
      parseMasterKey(bad);
      expect.unreachable('應該拋錯');
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });
});

describe('每檔金鑰衍生', () => {
  it('衍生出 32 位元組金鑰', () => {
    expect(keyFor('/repos/a/b/objects/pack-1.pack')).toHaveLength(MASTER_KEY_BYTES);
  });

  it('同一路徑衍生結果具決定性', () => {
    expect(keyFor('/x/y.json').equals(keyFor('/x/y.json'))).toBe(true);
  });

  it('不同路徑衍生出不同金鑰', () => {
    expect(keyFor('/x/y.json').equals(keyFor('/x/z.json'))).toBe(false);
  });

  it('不同主金鑰衍生出不同金鑰', () => {
    const other = deriveFileKey(randomBytes(MASTER_KEY_BYTES), '/x/y.json');
    expect(other.equals(keyFor('/x/y.json'))).toBe(false);
  });

  it('衍生金鑰不得等於主金鑰本身', () => {
    expect(keyFor('/x/y.json').equals(MASTER)).toBe(false);
  });

  it('主金鑰長度不符時拒絕衍生', () => {
    expect(() => deriveFileKey(randomBytes(16), '/x/y.json')).toThrow(CryptoError);
  });
});

describe('整檔加解密', () => {
  it('往返後逐位元組相同', () => {
    const plain = randomBytes(5000);
    const key = keyFor('/f');
    expect(decryptBytes(key, encryptBytes(key, plain)).equals(plain)).toBe(true);
  });

  it('空內容也能往返', () => {
    const key = keyFor('/f');
    const cipher = encryptBytes(key, Buffer.alloc(0));
    expect(decryptBytes(key, cipher)).toHaveLength(0);
  });

  it('密文不得包含明文片段', () => {
    const plain = Buffer.from('ref: refs/heads/main 這段文字不得外洩', 'utf8');
    const cipher = encryptBytes(keyFor('/f'), plain);
    expect(cipher.includes(plain)).toBe(false);
    expect(cipher.toString('latin1')).not.toContain('refs/heads/main');
  });

  it('相同內容兩次加密得到不同密文', () => {
    const plain = Buffer.from('同樣的內容');
    const key = keyFor('/f');
    expect(encryptBytes(key, plain).equals(encryptBytes(key, plain))).toBe(false);
  });

  it('用別的檔案金鑰解密會失敗', () => {
    const cipher = encryptBytes(keyFor('/a.json'), Buffer.from('機密'));
    expect(() => decryptBytes(keyFor('/b.json'), cipher)).toThrow(CryptoError);
  });

  it('密文被改動一個位元就解不開', () => {
    const key = keyFor('/f');
    const cipher = encryptBytes(key, randomBytes(100));
    const index = CIPHER_HEADER_BYTES + 20;
    cipher[index] = (cipher[index] ?? 0) ^ 0x01;
    expect(() => decryptBytes(key, cipher)).toThrow(CryptoError);
  });

  it('檔頭被改動就解不開', () => {
    const key = keyFor('/f');
    const cipher = encryptBytes(key, randomBytes(100));
    cipher[0] = (cipher[0] ?? 0) ^ 0xff;
    expect(() => decryptBytes(key, cipher)).toThrow(CryptoError);
  });

  it('長度不足的密文拋錯而非回傳空值', () => {
    expect(() => decryptBytes(keyFor('/f'), Buffer.alloc(4))).toThrow(CryptoError);
  });

  it('跨越多個區塊時仍正確還原', () => {
    const key = keyFor('/f');
    const plain = randomBytes(1000);
    const cipher = encryptBytes(key, plain, 64);
    expect(decryptBytes(key, cipher).equals(plain)).toBe(true);
  });
});

describe('密文版面與檔頭', () => {
  it('預設區塊大小為 1 MiB', () => {
    expect(DEFAULT_CHUNK_BYTES).toBe(1024 * 1024);
  });

  it('檔頭帶出明文長度與區塊大小', () => {
    const cipher = encryptBytes(keyFor('/f'), randomBytes(300), 128);
    const layout = readCipherHeader(cipher);
    expect(layout).toEqual({ chunkSize: 128, plainSize: 300 });
  });

  it('只讀檔頭長度的位元組也能解析版面', () => {
    const cipher = encryptBytes(keyFor('/f'), randomBytes(300), 128);
    const layout = readCipherHeader(cipher.subarray(0, CIPHER_HEADER_BYTES));
    expect(layout.plainSize).toBe(300);
  });

  it('計算出的密文長度與實際長度一致', () => {
    const cipher = encryptBytes(keyFor('/f'), randomBytes(300), 128);
    expect(cipherLengthOf(readCipherHeader(cipher))).toBe(cipher.length);
  });

  it('空檔的密文長度等於檔頭長度', () => {
    const cipher = encryptBytes(keyFor('/f'), Buffer.alloc(0));
    expect(cipher).toHaveLength(CIPHER_HEADER_BYTES);
    expect(cipherLengthOf(readCipherHeader(cipher))).toBe(CIPHER_HEADER_BYTES);
  });

  it('魔術字不符時拋錯', () => {
    const cipher = encryptBytes(keyFor('/f'), randomBytes(10));
    cipher.write('XXXX', 0, 'utf8');
    expect(() => readCipherHeader(cipher)).toThrow(CryptoError);
  });

  it('區塊大小為 0 的檔頭被視為損壞', () => {
    const cipher = encryptBytes(keyFor('/f'), randomBytes(10), 8);
    cipher.writeUInt32BE(0, 8);
    expect(() => readCipherHeader(cipher)).toThrow(CryptoError);
  });

  it('拒絕非正整數的區塊大小', () => {
    expect(() => encryptBytes(keyFor('/f'), randomBytes(10), 0)).toThrow(CryptoError);
    expect(() => encryptBytes(keyFor('/f'), randomBytes(10), 1.5)).toThrow(CryptoError);
  });
});

describe('明文區間的隨機讀取', () => {
  const key = keyFor('/pack');
  const plain = randomBytes(1000);
  const cipher = encryptBytes(key, plain, 100);
  const layout = readCipherHeader(cipher);

  function read(start: number, end: number): Buffer {
    const plan = cipherRangeFor(layout, { start, end });
    const slice = cipher.subarray(plan.range.start, plan.range.end + 1);
    return decryptRange(key, layout, plan, slice, { start, end });
  }

  it('讀取單一區塊內的區間', () => {
    expect(read(10, 19).equals(plain.subarray(10, 20))).toBe(true);
  });

  it('讀取跨越兩個區塊的區間', () => {
    expect(read(95, 105).equals(plain.subarray(95, 106))).toBe(true);
  });

  it('讀取跨越多個區塊的區間', () => {
    expect(read(50, 850).equals(plain.subarray(50, 851))).toBe(true);
  });

  it('讀取整個檔案', () => {
    expect(read(0, 999).equals(plain)).toBe(true);
  });

  it('讀取最後一個位元組', () => {
    expect(read(999, 999).equals(plain.subarray(999))).toBe(true);
  });

  it('只抓需要的區塊，不是整檔', () => {
    const plan = cipherRangeFor(layout, { start: 10, end: 19 });
    expect(plan.range.end - plan.range.start + 1).toBeLessThan(cipher.length / 2);
  });

  it('區塊索引由明文位移換算而得', () => {
    expect(cipherRangeFor(layout, { start: 0, end: 5 }).firstChunk).toBe(0);
    expect(cipherRangeFor(layout, { start: 250, end: 255 }).firstChunk).toBe(2);
  });

  it('規劃出的密文區間不超出密文長度', () => {
    const plan = cipherRangeFor(layout, { start: 990, end: 999 });
    expect(plan.range.end).toBeLessThanOrEqual(cipher.length - 1);
  });

  it('超出明文長度的區間拋錯', () => {
    expect(() => cipherRangeFor(layout, { start: 995, end: 1005 })).toThrow(CryptoError);
  });

  it('負數起點拋錯', () => {
    expect(() => cipherRangeFor(layout, { start: -1, end: 5 })).toThrow(CryptoError);
  });

  it('終點小於起點拋錯', () => {
    expect(() => cipherRangeFor(layout, { start: 9, end: 3 })).toThrow(CryptoError);
  });

  it('區間內的區塊被竄改時讀取失敗', () => {
    const plan = cipherRangeFor(layout, { start: 10, end: 19 });
    const slice = Buffer.from(cipher.subarray(plan.range.start, plan.range.end + 1));
    slice[5] = (slice[5] ?? 0) ^ 0x01;
    expect(() => decryptRange(key, layout, plan, slice, { start: 10, end: 19 })).toThrow(
      CryptoError,
    );
  });

  it('切片長度與規劃不符時拋錯，避免回傳錯位資料', () => {
    const plan = cipherRangeFor(layout, { start: 10, end: 19 });
    const slice = cipher.subarray(plan.range.start, plan.range.end);
    expect(() => decryptRange(key, layout, plan, slice, { start: 10, end: 19 })).toThrow(
      CryptoError,
    );
  });

  it('把其他檔案的密文搬到本檔路徑也解不開', () => {
    const foreign = encryptBytes(keyFor('/other'), plain, 100);
    const plan = cipherRangeFor(layout, { start: 10, end: 19 });
    const slice = foreign.subarray(plan.range.start, plan.range.end + 1);
    expect(() => decryptRange(key, layout, plan, slice, { start: 10, end: 19 })).toThrow(
      CryptoError,
    );
  });
});
