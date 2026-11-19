import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LFS_POINTER_SNIFF_BYTES,
  LfsError,
  batchUrl,
  isLfsPointer,
  lfsOid,
  parseLfsPointer,
  requestLfsBatch,
} from '@/storage/lfs.js';

const REPO = 'acme/git-store';
const TOKEN = 'hf_secret_token_value';

function pointer(oid: string, size: number): Buffer {
  return Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${String(size)}\n`,
    'utf8',
  );
}

interface Call {
  body: string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function recorder(responses: Response[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      body: typeof init?.body === 'string' ? init.body : '',
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? 'GET',
      url: String(url),
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) {
      throw new Error('no response configured');
    }
    return response;
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('LFS 指標偵測', () => {
  it('認得 git-lfs 的指標開頭', () => {
    expect(isLfsPointer(pointer('a'.repeat(64), 10))).toBe(true);
  });

  // 儲存層第一次讀檔只會取回密文檔頭那幾個位元組，所以偵測必須在
  // 很短的前綴上就能判定，否則指標會被當成密文送去解密。
  it('只憑檔頭長度的片段就能判定', () => {
    const head = pointer('a'.repeat(64), 10).subarray(0, LFS_POINTER_SNIFF_BYTES);
    expect(isLfsPointer(head)).toBe(true);
  });

  it('偵測所需的位元組數不超過密文檔頭長度', () => {
    expect(LFS_POINTER_SNIFF_BYTES).toBeLessThanOrEqual(16);
  });

  it('不把密文誤判為指標', () => {
    expect(isLfsPointer(Buffer.from('ODGENC01xxxxxxxx', 'utf8'))).toBe(false);
  });

  it('太短的輸入不算指標', () => {
    expect(isLfsPointer(Buffer.from('ver'))).toBe(false);
  });

  it('空輸入不算指標', () => {
    expect(isLfsPointer(Buffer.alloc(0))).toBe(false);
  });
});

describe('LFS 指標解析', () => {
  it('取出 oid 與大小', () => {
    const oid = 'b'.repeat(64);
    expect(parseLfsPointer(pointer(oid, 4096))).toEqual({ oid, size: 4096 });
  });

  it('容許行序不同', () => {
    const oid = 'c'.repeat(64);
    const body = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\nsize 7\noid sha256:${oid}\n`,
      'utf8',
    );
    expect(parseLfsPointer(body)).toEqual({ oid, size: 7 });
  });

  it('缺少 oid 時拋錯', () => {
    const body = Buffer.from('version https://git-lfs.github.com/spec/v1\nsize 7\n', 'utf8');
    expect(() => parseLfsPointer(body)).toThrow(LfsError);
  });

  it('缺少 size 時拋錯', () => {
    const body = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'d'.repeat(64)}\n`,
      'utf8',
    );
    expect(() => parseLfsPointer(body)).toThrow(LfsError);
  });

  it('oid 長度不符時拋錯', () => {
    const body = Buffer.from(
      'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 7\n',
      'utf8',
    );
    expect(() => parseLfsPointer(body)).toThrow(LfsError);
  });

  it('只有檔頭片段時拋錯而非回傳半截資料', () => {
    const head = pointer('e'.repeat(64), 10).subarray(0, LFS_POINTER_SNIFF_BYTES);
    expect(() => parseLfsPointer(head)).toThrow(LfsError);
  });
});

describe('物件識別碼', () => {
  it('以 sha256 計算且與 node 內建一致', () => {
    const body = Buffer.from('hello lfs', 'utf8');
    expect(lfsOid(body)).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('長度為 64 個小寫 hex 字元', () => {
    expect(lfsOid(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空內容也有識別碼', () => {
    expect(lfsOid(Buffer.alloc(0))).toHaveLength(64);
  });
});

describe('batch 端點', () => {
  it('打在資料集的 git LFS 路徑上', () => {
    expect(batchUrl(REPO)).toBe(`https://huggingface.co/datasets/${REPO}.git/info/lfs/objects/batch`);
  });
});

describe('batch 協商', () => {
  const oid = 'f'.repeat(64);

  it('以 git-lfs 的媒體型別協商', async () => {
    const { calls, fetchImpl } = recorder([
      json({ objects: [{ actions: { download: { href: 'https://cdn/obj' } }, oid, size: 12 }] }),
    ]);
    await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'download',
      repoId: REPO,
      size: 12,
      token: TOKEN,
    });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers['accept']).toBe('application/vnd.git-lfs+json');
    expect(call?.headers['content-type']).toBe('application/vnd.git-lfs+json');
  });

  it('送出操作、雜湊演算法與物件清單', async () => {
    const { calls, fetchImpl } = recorder([
      json({ objects: [{ actions: { upload: { href: 'https://cdn/put' } }, oid, size: 99 }] }),
    ]);
    await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId: REPO,
      size: 99,
      token: TOKEN,
    });
    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      hash_algo: string;
      objects: { oid: string; size: number }[];
      operation: string;
      transfers: string[];
    };
    expect(body.operation).toBe('upload');
    expect(body.hash_algo).toBe('sha256');
    expect(body.transfers).toContain('basic');
    expect(body.objects).toEqual([{ oid, size: 99 }]);
  });

  it('帶上存取權杖', async () => {
    const { calls, fetchImpl } = recorder([
      json({ objects: [{ actions: { upload: { href: 'https://cdn/put' } }, oid, size: 1 }] }),
    ]);
    await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId: REPO,
      size: 1,
      token: TOKEN,
    });
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('沒有權杖時不加授權標頭', async () => {
    const { calls, fetchImpl } = recorder([
      json({ objects: [{ actions: { download: { href: 'https://cdn/obj' } }, oid, size: 1 }] }),
    ]);
    await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'download',
      repoId: REPO,
      size: 1,
      token: null,
    });
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('回傳動作的網址與附帶標頭', async () => {
    const { fetchImpl } = recorder([
      json({
        objects: [
          {
            actions: { download: { header: { 'x-amz-token': 'abc' }, href: 'https://cdn/obj' } },
            oid,
            size: 5,
          },
        ],
      }),
    ]);
    const action = await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'download',
      repoId: REPO,
      size: 5,
      token: TOKEN,
    });
    expect(action).toEqual({ headers: { 'x-amz-token': 'abc' }, href: 'https://cdn/obj' });
  });

  // 上傳協商沒有 actions 代表內容已經在儲存桶裡，這時跳過上傳是正確行為，
  // 不是錯誤：同一份 packfile 重複推送會落在這條路徑上。
  it('沒有動作時回 null 表示物件已存在', async () => {
    const { fetchImpl } = recorder([json({ objects: [{ oid, size: 5 }] })]);
    const action = await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId: REPO,
      size: 5,
      token: TOKEN,
    });
    expect(action).toBeNull();
  });

  it('上游回報物件層級的錯誤時拋錯', async () => {
    const { fetchImpl } = recorder([
      json({ objects: [{ error: { code: 404, message: 'not found' }, oid, size: 5 }] }),
    ]);
    await expect(
      requestLfsBatch({
        fetchImpl,
        oid,
        operation: 'download',
        repoId: REPO,
        size: 5,
        token: TOKEN,
      }),
    ).rejects.toThrow(LfsError);
  });

  it('回應沒有物件清單時拋錯', async () => {
    const { fetchImpl } = recorder([json({ objects: [] })]);
    await expect(
      requestLfsBatch({
        fetchImpl,
        oid,
        operation: 'download',
        repoId: REPO,
        size: 5,
        token: TOKEN,
      }),
    ).rejects.toThrow(LfsError);
  });

  it('協商被拒時拋出帶狀態碼的錯誤', async () => {
    const { fetchImpl } = recorder([new Response('denied', { status: 403 })]);
    const error = await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId: REPO,
      size: 5,
      token: TOKEN,
    }).catch((caught: unknown) => caught as LfsError);
    expect(error).toBeInstanceOf(LfsError);
    expect((error as LfsError).status).toBe(403);
  });

  it('錯誤訊息不洩漏權杖也不轉述上游內容', async () => {
    const { fetchImpl } = recorder([new Response(`denied for ${TOKEN}`, { status: 403 })]);
    let message = '';
    try {
      await requestLfsBatch({
        fetchImpl,
        oid,
        operation: 'upload',
        repoId: REPO,
        size: 5,
        token: TOKEN,
      });
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('denied');
  });

  it('遇到限流會重試', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const { calls, fetchImpl } = recorder([
      new Response('slow down', { status: 429 }),
      json({ objects: [{ actions: { upload: { href: 'https://cdn/put' } }, oid, size: 5 }] }),
    ]);
    const action = await requestLfsBatch({
      fetchImpl,
      oid,
      operation: 'upload',
      repoId: REPO,
      size: 5,
      sleep,
      token: TOKEN,
    });
    expect(action?.href).toBe('https://cdn/put');
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalled();
  });
});
