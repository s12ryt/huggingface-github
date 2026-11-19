import { describe, expect, it, vi } from 'vitest';
import {
  createHubClient,
  DEFAULT_LFS_THRESHOLD_BYTES,
  LFS_EXTENSIONS,
  shouldUseLfs,
} from '@/storage/hf.js';
import { lfsOid } from '@/storage/lfs.js';

const REPO = 'acme/git-store';
const TOKEN = 'hf_secret_token_value';
const BATCH_URL = `https://huggingface.co/datasets/${REPO}.git/info/lfs/objects/batch`;
const HREF = 'https://cas-bridge.example/upload/abc123';

interface Call {
  body: string;
  headers: Record<string, string>;
  method: string;
  rawBody: unknown;
  url: string;
}

function recorder(responses: Response[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const raw = init.body;
    calls.push({
      body: typeof raw === 'string' ? raw : Buffer.from((raw ?? '') as Uint8Array).toString('utf8'),
      headers: (init.headers ?? {}) as Record<string, string>,
      method: init.method ?? 'GET',
      rawBody: raw,
      url,
    });
    const picked = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return picked ?? new Response('', { status: 200 });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function batchReply(href = HREF, headers: Record<string, string> = {}, operation = 'upload'): Response {
  return new Response(
    JSON.stringify({ objects: [{ actions: { [operation]: { header: headers, href } } }] }),
    { headers: { 'content-type': 'application/vnd.git-lfs+json' }, status: 200 },
  );
}

function pointerOf(body: Buffer): Buffer {
  return Buffer.from(
    [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${lfsOid(body)}`,
      `size ${String(body.length)}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function bytes(buffer: Buffer, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(buffer, { headers, status });
}

interface Harness {
  calls: Call[];
  hub: ReturnType<typeof createHubClient>;
  now: { value: number };
}

function client(
  responses: Response[],
  overrides: Partial<Parameters<typeof createHubClient>[0]> = {},
): Harness {
  const { calls, fetchImpl } = recorder(responses);
  const now = { value: 1_000_000 };
  const hub = createHubClient({
    fetchImpl,
    now: () => now.value,
    repoId: REPO,
    revision: 'main',
    sleep: vi.fn<(ms: number) => Promise<void>>(async () => undefined),
    token: TOKEN,
    ...overrides,
  });
  return { calls, hub, now };
}

describe('LFS 門檻與副檔名判定', () => {
  it('預設門檻為 10 MiB', () => {
    expect(DEFAULT_LFS_THRESHOLD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('小檔案且副檔名不在清單上時走一般上傳', () => {
    expect(shouldUseLfs('repos/a/b/issues/1.json', 512)).toBe(false);
  });

  it('超過門檻的檔案走 LFS', () => {
    expect(shouldUseLfs('repos/a/b/issues/1.json', DEFAULT_LFS_THRESHOLD_BYTES)).toBe(true);
  });

  // HuggingFace 資料集的預設 .gitattributes 就把 *.pack 歸到 LFS，
  // 所以小的 packfile 也必須走 LFS，否則上傳與下載的格式會不一致。
  it('packfile 不論大小都走 LFS', () => {
    expect(shouldUseLfs('repos/a/b/objects/pack-1.pack', 32)).toBe(true);
  });

  it('副檔名清單包含 .pack', () => {
    expect(LFS_EXTENSIONS).toContain('.pack');
  });
});

describe('LFS 上傳', () => {
  const big = Buffer.alloc(DEFAULT_LFS_THRESHOLD_BYTES, 7);

  it('先向 batch 端點協商上傳', async () => {
    const { calls, hub } = client([batchReply(), bytes(Buffer.alloc(0)), bytes(Buffer.alloc(0))]);
    await hub.putFile('big.bin', big);
    expect(calls[0]?.url).toBe(BATCH_URL);
    const payload = JSON.parse(calls[0]?.body ?? '{}') as {
      objects: { oid: string; size: number }[];
      operation: string;
    };
    expect(payload.operation).toBe('upload');
    expect(payload.objects[0]?.oid).toBe(lfsOid(big));
    expect(payload.objects[0]?.size).toBe(big.length);
  });

  it('依協商結果把裸位元組 PUT 到指定網址', async () => {
    const { calls, hub } = client([
      batchReply(HREF, { 'x-amz-acl': 'private' }),
      bytes(Buffer.alloc(0)),
      bytes(Buffer.alloc(0)),
    ]);
    await hub.putFile('big.bin', big);
    expect(calls[1]?.url).toBe(HREF);
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.headers['x-amz-acl']).toBe('private');
  });

  // 大檔上傳時整份複製會讓峰值記憶體翻倍，所以 PUT 主體必須是同一個 Buffer。
  // .bin 副檔名不論大小都走 LFS，用小 Buffer 就能驗證參考等性，
  // 也避免斷言失敗時對大緩衝做差異比對。
  it('位元組上傳不複製傳入的 Buffer', async () => {
    const body = Buffer.alloc(4096, 7);
    const { calls, hub } = client([
      batchReply(),
      bytes(Buffer.alloc(0)),
      bytes(Buffer.alloc(0)),
    ]);
    await hub.putFile('blob.bin', body);
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.rawBody).toBe(body);
  });

  it('最後以 lfsFile 操作提交指標', async () => {
    const { calls, hub } = client([batchReply(), bytes(Buffer.alloc(0)), bytes(Buffer.alloc(0))]);
    await hub.putFile('big.bin', big);
    const lines = (calls[2]?.body ?? '').trim().split('\n');
    const operation = JSON.parse(lines[1] ?? '{}') as {
      key: string;
      value: { algo: string; oid: string; path: string; size: number };
    };
    expect(operation.key).toBe('lfsFile');
    expect(operation.value).toMatchObject({
      algo: 'sha256',
      oid: lfsOid(big),
      path: 'big.bin',
      size: big.length,
    });
  });

  // 儲存桶已經有這份內容時 batch 不會回動作，此時只要補上指標即可。
  it('協商未回動作時跳過位元組上傳但仍提交指標', async () => {
    const { calls, hub } = client([
      new Response(JSON.stringify({ objects: [{ actions: {} }] }), { status: 200 }),
      bytes(Buffer.alloc(0)),
    ]);
    await hub.putFile('big.bin', big);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('/api/datasets/');
    expect(calls[1]?.body).toContain('lfsFile');
  });

  it('小檔案仍以 base64 內嵌上傳且不觸發協商', async () => {
    const { calls, hub } = client([bytes(Buffer.alloc(0))]);
    await hub.putFile('small.json', Buffer.from('{}'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/datasets/');
    expect(calls[0]?.body).toContain('"key":"file"');
  });

  it('沒有權杖時大檔上傳直接拒絕且不發出請求', async () => {
    const { calls, hub } = client([batchReply()], { token: null });
    await expect(hub.putFile('big.bin', big)).rejects.toThrow(/access token/);
    expect(calls).toHaveLength(0);
  });

  it('位元組上傳失敗時拋出錯誤且訊息不含權杖', async () => {
    const { hub } = client([batchReply(), new Response('denied', { status: 403 })]);
    let message = '';
    try {
      await hub.putFile('big.bin', big);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('denied');
  });
});

describe('LFS 下載偵測', () => {
  const real = Buffer.from('0123456789abcdef', 'utf8');

  it('取到指標時改向 batch 協商下載並回傳真正的位元組', async () => {
    const { calls, hub } = client([
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
    ]);
    const got = await hub.readAll('big.bin');
    expect(got?.equals(real)).toBe(true);
    expect(calls[1]?.url).toBe(BATCH_URL);
    expect(JSON.parse(calls[1]?.body ?? '{}').operation).toBe('download');
    expect(calls[2]?.url).toBe(HREF);
  });

  it('第二次讀取同一路徑時重用已協商的網址', async () => {
    const { calls, hub } = client([
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
      bytes(real),
    ]);
    await hub.readAll('big.bin');
    const before = calls.length;
    await hub.readAll('big.bin');
    expect(calls).toHaveLength(before + 1);
    expect(calls[before]?.url).toBe(HREF);
  });

  it('網址過期後重新協商', async () => {
    const { calls, hub, now } = client([
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
    ]);
    await hub.readAll('big.bin');
    now.value += 60 * 60 * 1000;
    await hub.readAll('big.bin');
    expect(calls.filter((call) => call.url === BATCH_URL)).toHaveLength(2);
  });

  it('一般內容直接回傳且不觸發協商', async () => {
    const { calls, hub } = client([bytes(real)]);
    const got = await hub.readAll('plain.bin');
    expect(got?.equals(real)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('區間讀取遇到指標時改以協商網址重發並帶上區間標頭', async () => {
    const { calls, hub } = client([
      bytes(pointerOf(real)),
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real.subarray(2, 5), 206),
    ]);
    const got = await hub.readRange('big.bin', { end: 4, start: 2 });
    expect(got.toString('utf8')).toBe('234');
    const last = calls.at(-1);
    expect(last?.url).toBe(HREF);
    expect(last?.headers.range).toBe('bytes=2-4');
  });

  // 轉送目標也可能忽略 Range 而回整檔，此時仍須自行切片。
  it('協商網址回整檔時自行切出所求區間', async () => {
    const { hub } = client([
      bytes(pointerOf(real)),
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real, 200),
    ]);
    const got = await hub.readRange('big.bin', { end: 4, start: 2 });
    expect(got.toString('utf8')).toBe('234');
  });
});

describe('大小查詢與快取失效', () => {
  it('優先採用 LFS 實際大小標頭', async () => {
    const { hub } = client([
      new Response('', { headers: { 'content-length': '133', 'x-linked-size': '4096' }, status: 200 }),
    ]);
    expect(await hub.statFile('big.bin')).toBe(4096);
  });

  it('沒有 LFS 大小標頭時沿用 content-length', async () => {
    const { hub } = client([
      new Response('', { headers: { 'content-length': '133' }, status: 200 }),
    ]);
    expect(await hub.statFile('plain.json')).toBe(133);
  });

  it('覆寫同一路徑後不再沿用舊的協商網址', async () => {
    const real = Buffer.from('0123456789abcdef', 'utf8');
    const { calls, hub } = client([
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
      batchReply(),
      bytes(Buffer.alloc(0)),
      bytes(Buffer.alloc(0)),
      bytes(pointerOf(real)),
      batchReply(HREF, {}, 'download'),
      bytes(real),
    ]);
    await hub.readAll('big.bin');
    await hub.putFile('big.bin', Buffer.alloc(DEFAULT_LFS_THRESHOLD_BYTES, 1));
    await hub.readAll('big.bin');
    expect(calls.filter((call) => call.url === BATCH_URL)).toHaveLength(3);
  });
});
