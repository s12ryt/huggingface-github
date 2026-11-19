import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CIPHER_HEADER_BYTES, parseMasterKey } from '@/storage/crypto.js';
import type { ByteRange } from '@/storage/ranges.js';
import { createHubStore, type Store } from '@/storage/store.js';

const MASTER_KEY = parseMasterKey('a'.repeat(64));
const OTHER_KEY = parseMasterKey('b'.repeat(64));

interface FakeHub {
  deleteFile(path: string): Promise<void>;
  putFile(path: string, body: Buffer): Promise<void>;
  readAll(path: string): Promise<Buffer | null>;
  readRange(path: string, range: ByteRange): Promise<Buffer>;
  statFile(path: string): Promise<number | null>;
  files: Map<string, Buffer>;
  rangeRequests: ByteRange[];
  readAllCalls: number;
}

function fakeHub(): FakeHub {
  const files = new Map<string, Buffer>();
  const rangeRequests: ByteRange[] = [];
  return {
    files,
    rangeRequests,
    readAllCalls: 0,
    async deleteFile(path) {
      files.delete(path);
    },
    async putFile(path, body) {
      files.set(path, Buffer.from(body));
    },
    async readAll(path) {
      this.readAllCalls += 1;
      return files.get(path) ?? null;
    },
    async readRange(path, range) {
      const file = files.get(path);
      if (!file) {
        throw new Error(`missing ${path}`);
      }
      rangeRequests.push(range);
      return file.subarray(range.start, range.end + 1);
    },
    async statFile(path) {
      return files.get(path)?.length ?? null;
    },
  };
}

interface Harness {
  hub: FakeHub;
  store: Store;
}

function harness(options: { cacheBytes?: number; chunkSize?: number; mergeMaxGap?: number } = {}): Harness {
  const hub = fakeHub();
  const store = createHubStore({
    cacheMaxBytes: options.cacheBytes ?? 1024 * 1024,
    hub,
    masterKey: MASTER_KEY,
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    ...(options.mergeMaxGap === undefined ? {} : { mergeMaxGap: options.mergeMaxGap }),
  });
  return { hub, store };
}

describe('加密對上層透明', () => {
  let ctx: Harness;

  beforeEach(() => {
    ctx = harness();
  });

  it('寫入後讀回逐位元組相同', async () => {
    const plain = Buffer.from('ref: refs/heads/main\n');
    await ctx.store.putBytes('/repos/a/b/HEAD', plain);
    const read = await ctx.store.readAll('/repos/a/b/HEAD');
    expect(read?.equals(plain)).toBe(true);
  });

  it('公開桶上存放的位元組不含明文片段', async () => {
    await ctx.store.putBytes('/repos/a/b/HEAD', Buffer.from('ref: refs/heads/main\n'));
    const stored = [...ctx.hub.files.values()][0];
    expect(stored).toBeDefined();
    expect(stored?.toString('latin1')).not.toContain('refs/heads/main');
  });

  it('相同內容寫兩次密文不相同', async () => {
    const plain = Buffer.from('identical content');
    await ctx.store.putBytes('/a', plain);
    const first = Buffer.from(ctx.hub.files.get('/a') as Buffer);
    await ctx.store.putBytes('/a', plain);
    const second = ctx.hub.files.get('/a') as Buffer;
    expect(first.equals(second)).toBe(false);
  });

  it('密文開頭是加密檔頭而非明文', async () => {
    await ctx.store.putBytes('/a', Buffer.from('plain text here'));
    const stored = ctx.hub.files.get('/a') as Buffer;
    expect(stored.length).toBeGreaterThan(CIPHER_HEADER_BYTES);
    expect(stored.subarray(0, 8).toString('utf8')).not.toBe('plain te');
  });

  it('空內容也能往返', async () => {
    await ctx.store.putBytes('/empty', Buffer.alloc(0));
    const read = await ctx.store.readAll('/empty');
    expect(read?.length).toBe(0);
  });

  it('不存在的檔案回 null', async () => {
    expect(await ctx.store.readAll('/nope')).toBeNull();
  });

  it('同一份密文搬到別的路徑就解不開', async () => {
    await ctx.store.putBytes('/original', Buffer.from('secret payload'));
    const cipher = ctx.hub.files.get('/original') as Buffer;
    ctx.hub.files.set('/moved', cipher);
    await expect(ctx.store.readAll('/moved')).rejects.toThrow();
  });

  it('換一把主金鑰就解不開既有檔案', async () => {
    await ctx.store.putBytes('/a', Buffer.from('secret payload'));
    const other = createHubStore({ cacheMaxBytes: 1024, hub: ctx.hub, masterKey: OTHER_KEY });
    await expect(other.readAll('/a')).rejects.toThrow();
  });

  it('密文被竄改一個位元就讀不出來', async () => {
    await ctx.store.putBytes('/a', Buffer.from('secret payload'));
    const stored = ctx.hub.files.get('/a') as Buffer;
    const index = stored.length - 1;
    stored[index] = (stored[index] as number) ^ 0x01;
    const fresh = createHubStore({ cacheMaxBytes: 1024, hub: ctx.hub, masterKey: MASTER_KEY });
    await expect(fresh.readAll('/a')).rejects.toThrow();
  });
});

describe('明文區間讀取', () => {
  const PAYLOAD = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

  it('回傳所求的明文區間', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/pack', PAYLOAD);
    const [first, second] = await ctx.store.readRanges('/pack', [
      { start: 0, end: 2 },
      { start: 30, end: 34 },
    ]);
    expect(first?.toString('utf8')).toBe('012');
    expect(second?.toString('utf8')).toBe('uvwxy');
  });

  it('依請求順序回傳，與輸入排序無關', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/pack', PAYLOAD);
    const result = await ctx.store.readRanges('/pack', [
      { start: 10, end: 11 },
      { start: 0, end: 1 },
    ]);
    expect(result.map((part) => part.toString('utf8'))).toEqual(['ab', '01']);
  });

  it('跨多個加密區塊的區間也正確', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    const [part] = await ctx.store.readRanges('/pack', [{ start: 5, end: 20 }]);
    expect(part?.toString('utf8')).toBe(PAYLOAD.subarray(5, 21).toString('utf8'));
  });

  it('單一位元組的區間也正確', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    const [part] = await ctx.store.readRanges('/pack', [{ start: 35, end: 35 }]);
    expect(part?.toString('utf8')).toBe('z');
  });

  it('空的區間清單不觸發任何網路請求', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/pack', PAYLOAD);
    ctx.hub.rangeRequests.length = 0;
    const result = await ctx.store.readRanges('/pack', []);
    expect(result).toEqual([]);
    expect(ctx.hub.rangeRequests).toHaveLength(0);
  });

  it('相鄰的兩段只發出一次區間請求', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    const fresh = createHubStore({ cacheMaxBytes: 1024 * 1024, chunkSize: 8, hub: ctx.hub, masterKey: MASTER_KEY });
    ctx.hub.rangeRequests.length = 0;
    await fresh.readRanges('/pack', [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
    const contentRequests = ctx.hub.rangeRequests.filter((range) => range.start >= CIPHER_HEADER_BYTES);
    expect(contentRequests).toHaveLength(1);
  });

  it('只抓需要的區塊而非整個檔案', async () => {
    const ctx = harness({ chunkSize: 4 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    const cipherLength = (ctx.hub.files.get('/pack') as Buffer).length;
    const fresh = createHubStore({ cacheMaxBytes: 1024 * 1024, chunkSize: 4, hub: ctx.hub, masterKey: MASTER_KEY });
    ctx.hub.rangeRequests.length = 0;
    await fresh.readRanges('/pack', [{ start: 0, end: 1 }]);
    const fetched = ctx.hub.rangeRequests.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
    expect(fetched).toBeLessThan(cipherLength / 2);
  });

  it('超出明文長度的區間拋錯', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/pack', PAYLOAD);
    await expect(ctx.store.readRanges('/pack', [{ start: 0, end: PAYLOAD.length }])).rejects.toThrow();
  });

  it('讀取不存在的檔案拋錯而非回空值', async () => {
    const ctx = harness();
    await expect(ctx.store.readRanges('/missing', [{ start: 0, end: 1 }])).rejects.toThrow();
  });
});

describe('快取與失效', () => {
  const PAYLOAD = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

  it('第二次讀取同一區間不再打網路', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    ctx.hub.rangeRequests.length = 0;
    const [part] = await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    expect(part?.toString('utf8')).toBe('0123');
    expect(ctx.hub.rangeRequests).toHaveLength(0);
  });

  it('快取命中計入統計', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    expect(ctx.store.cacheStats().hits).toBeGreaterThan(0);
  });

  it('快取上限為 0 時每次都回源', async () => {
    const ctx = harness({ cacheBytes: 0, chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    ctx.hub.rangeRequests.length = 0;
    const [part] = await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    expect(part?.toString('utf8')).toBe('0123');
    expect(ctx.hub.rangeRequests.length).toBeGreaterThan(0);
  });

  it('覆寫同一路徑後讀到的是新內容', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    await ctx.store.putBytes('/pack', Buffer.from('NEWCONTENT'));
    const read = await ctx.store.readAll('/pack');
    expect(read?.toString('utf8')).toBe('NEWCONTENT');
  });

  it('覆寫後舊的區間快取不再被採用', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/pack', PAYLOAD);
    await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    await ctx.store.putBytes('/pack', Buffer.from('ZZZZZZZZZZ'));
    const [part] = await ctx.store.readRanges('/pack', [{ start: 0, end: 3 }]);
    expect(part?.toString('utf8')).toBe('ZZZZ');
  });

  it('不同路徑的相同位移不互相污染', async () => {
    const ctx = harness({ chunkSize: 8 });
    await ctx.store.putBytes('/one', Buffer.from('AAAAAAAA'));
    await ctx.store.putBytes('/two', Buffer.from('BBBBBBBB'));
    const [a] = await ctx.store.readRanges('/one', [{ start: 0, end: 1 }]);
    const [b] = await ctx.store.readRanges('/two', [{ start: 0, end: 1 }]);
    expect(a?.toString('utf8')).toBe('AA');
    expect(b?.toString('utf8')).toBe('BB');
  });

  it('刪除後讀取回 null', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/gone', Buffer.from('bye'));
    await ctx.store.readAll('/gone');
    await ctx.store.remove('/gone');
    expect(await ctx.store.readAll('/gone')).toBeNull();
  });
});

describe('JSON 讀寫', () => {
  it('往返保留結構', async () => {
    const ctx = harness();
    await ctx.store.putJson('/issues/1.json', { number: 1, title: '標題' });
    expect(await ctx.store.readJson('/issues/1.json')).toEqual({ number: 1, title: '標題' });
  });

  it('以縮排格式與尾換行儲存，便於人工閱讀與比對', async () => {
    const ctx = harness();
    await ctx.store.putJson('/issues/1.json', { number: 1 });
    const read = await ctx.store.readAll('/issues/1.json');
    expect(read?.toString('utf8')).toBe(`${JSON.stringify({ number: 1 }, null, 2)}\n`);
  });

  it('不存在的檔案回 null', async () => {
    const ctx = harness();
    expect(await ctx.store.readJson('/issues/9.json')).toBeNull();
  });

  it('無法解析的內容回 null 而非拋錯', async () => {
    const ctx = harness();
    await ctx.store.putBytes('/issues/2.json', Buffer.from('{ not json'));
    expect(await ctx.store.readJson('/issues/2.json')).toBeNull();
  });
});

describe('並行抓取', () => {
  it('合併距離外的多個區間會同時發出請求', async () => {
    const files = new Map<string, Buffer>();
    interface Pending {
      path: string;
      range: ByteRange;
      resolve(value: Buffer): void;
    }
    const pending: Pending[] = [];
    let started = 0;
    const stored = () => files.get('/p/x.pack') ?? Buffer.alloc(0);
    const hub = {
      async deleteFile() {},
      async putFile(path: string, body: Buffer) {
        files.set(path, body);
      },
      async readAll(path: string) {
        return files.get(path) ?? null;
      },
      async readRange(path: string, range: ByteRange) {
        started += 1;
        const file = files.get(path);
        if (!file) throw new Error(`missing ${path}`);
        return new Promise<Buffer>((resolve) => {
          pending.push({ path, range, resolve });
        });
      },
      async statFile(path: string) {
        return files.get(path)?.length ?? null;
      },
    };
    const store = createHubStore({
      cacheMaxBytes: 1024 * 1024,
      // 小塊讓兩個請求落在不同密文塊，擴展後成為兩個距離超過合併門檻的 span
      chunkSize: 8,
      hub,
      masterKey: MASTER_KEY,
      mergeMaxGap: 0,
    });
    const plain = Buffer.alloc(300_000, 7);
    await store.putBytes('/p/x.pack', plain);

    const reading = store.readRanges('/p/x.pack', [
      { start: 0, end: 15 },
      { start: 200_000, end: 200_015 },
    ]);
    // 第 1 個請求是密文檔頭；釋放後兩個 span 應同時在飛，而非依序等待
    await vi.waitFor(() => expect(started).toBe(1));
    pending.shift()?.resolve(stored().subarray(0, 16));
    await vi.waitFor(() => expect(started).toBe(3));
    for (const entry of pending.splice(0)) {
      entry.resolve(stored().subarray(entry.range.start, entry.range.end + 1));
    }
    const chunks = await reading;
    expect(chunks[0]?.equals(plain.subarray(0, 16))).toBe(true);
    expect(chunks[1]?.equals(plain.subarray(200_000, 200_016))).toBe(true);
  });
});
