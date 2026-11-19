/**
 * HuggingFace Hub 客戶端契約測試。
 *
 * 功能位置：
 * - 路徑與網址組裝 : 行 40
 * - 上傳與刪除     : 行 95
 * - 下載與區間讀取 : 行 185
 * - 重試與限流     : 行 265
 * - 權杖不外洩     : 行 330
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createHubClient,
  HubError,
  MAX_RETRIES,
  resolveUrl,
  type HubClientOptions,
} from '@/storage/hf.js';

const REPO = 'acme/git-store';
const TOKEN = 'hf_secret_token_value';

interface Call {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function recorder(responses: Response[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: headers ?? {},
      method: init?.method ?? 'GET',
      url: String(input),
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) {
      throw new Error('no stub response');
    }
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function ok(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function bytes(buffer: Buffer, status = 200): Response {
  return new Response(new Uint8Array(buffer), { status });
}

function fail(status: number, headers: Record<string, string> = {}): Response {
  return new Response('upstream rejected', { headers, status });
}

function client(responses: Response[], overrides: Partial<HubClientOptions> = {}) {
  const { calls, fetchImpl } = recorder(responses);
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const hub = createHubClient({
    fetchImpl,
    repoId: REPO,
    revision: 'main',
    sleep,
    token: TOKEN,
    ...overrides,
  });
  return { calls, hub, sleep };
}

describe('HuggingFace 路徑與網址組裝', () => {
  it('下載網址指向 dataset 的 resolve 端點', () => {
    expect(resolveUrl(REPO, 'main', 'repos/a/b.pack')).toBe(
      'https://huggingface.co/datasets/acme/git-store/resolve/main/repos/a/b.pack',
    );
  });

  it('路徑開頭的斜線不會產生重複斜線', () => {
    expect(resolveUrl(REPO, 'main', '/repos/a')).toBe(
      'https://huggingface.co/datasets/acme/git-store/resolve/main/repos/a',
    );
  });

  it('路徑片段逐段編碼但保留目錄斜線', () => {
    expect(resolveUrl(REPO, 'main', 'repos/my repo/a#b.json')).toBe(
      'https://huggingface.co/datasets/acme/git-store/resolve/main/repos/my%20repo/a%23b.json',
    );
  });

  it('拒絕路徑穿越', () => {
    expect(() => resolveUrl(REPO, 'main', 'repos/../../etc/passwd')).toThrow(HubError);
  });

  it('修訂版本可自訂', () => {
    expect(resolveUrl(REPO, 'refs%2Fpr%2F1', 'a.txt')).toBe(
      'https://huggingface.co/datasets/acme/git-store/resolve/refs%2Fpr%2F1/a.txt',
    );
  });
});

// 本組驗證的是「小檔直接以 base64 夾帶在 commit 裡」這條路徑，所以刻意用
// 非 LFS 的副檔名。`.pack` 會被 HuggingFace 的預設 .gitattributes 歸到 LFS，
// 走的是另一條流程，由 tests/storage/hf-lfs.test.ts 負責驗證。
describe('HuggingFace 上傳與刪除', () => {
  it('上傳打到 commit 端點並帶上修訂版本', async () => {
    const { calls, hub } = client([ok()]);
    await hub.putFile('repos/a/b.json', Buffer.from('payload'));
    expect(calls[0]?.url).toBe('https://huggingface.co/api/datasets/acme/git-store/commit/main');
    expect(calls[0]?.method).toBe('POST');
  });

  it('上傳以 NDJSON 送出標頭行與檔案行', async () => {
    const { calls, hub } = client([ok()]);
    await hub.putFile('repos/a/b.json', Buffer.from('payload'));
    const lines = (calls[0]?.body ?? '').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ key: 'header' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ key: 'file' });
  });

  it('檔案內容以 base64 編碼夾帶', async () => {
    const { calls, hub } = client([ok()]);
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    await hub.putFile('repos/a/b.json', payload);
    const line = JSON.parse((calls[0]?.body ?? '').trim().split('\n')[1] ?? '{}');
    expect(line.value.encoding).toBe('base64');
    expect(Buffer.from(line.value.content, 'base64').equals(payload)).toBe(true);
  });

  it('上傳帶上路徑且去除開頭斜線', async () => {
    const { calls, hub } = client([ok()]);
    await hub.putFile('/repos/a/b.json', Buffer.from('x'));
    const line = JSON.parse((calls[0]?.body ?? '').trim().split('\n')[1] ?? '{}');
    expect(line.value.path).toBe('repos/a/b.json');
  });

  it('上傳帶 Authorization 標頭', async () => {
    const { calls, hub } = client([ok()]);
    await hub.putFile('a.txt', Buffer.from('x'));
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('刪除以 deletedFile 指令送出', async () => {
    const { calls, hub } = client([ok()]);
    await hub.deleteFile('repos/a/b.pack');
    const line = JSON.parse((calls[0]?.body ?? '').trim().split('\n')[1] ?? '{}');
    expect(line.key).toBe('deletedFile');
    expect(line.value.path).toBe('repos/a/b.pack');
  });

  it('刪除不存在的檔案視為成功以保持幂等', async () => {
    const { hub } = client([fail(404)]);
    await expect(hub.deleteFile('missing.txt')).resolves.toBeUndefined();
  });

  it('上傳遭拒時拋出帶狀態碼的錯誤', async () => {
    const { hub } = client([fail(403)]);
    await expect(hub.putFile('a.txt', Buffer.from('x'))).rejects.toMatchObject({ status: 403 });
  });

  it('沒有權杖時上傳直接拒絕而不發出請求', async () => {
    const { calls, hub } = client([ok()], { token: null });
    await expect(hub.putFile('a.txt', Buffer.from('x'))).rejects.toThrow(HubError);
    expect(calls).toHaveLength(0);
  });
});

describe('HuggingFace 下載與區間讀取', () => {
  it('讀取整檔回傳位元組', async () => {
    const payload = Buffer.from('hello hub');
    const { hub } = client([bytes(payload)]);
    const result = await hub.readAll('a.txt');
    expect(result?.equals(payload)).toBe(true);
  });

  it('檔案不存在回傳 null', async () => {
    const { hub } = client([fail(404)]);
    await expect(hub.readAll('missing.txt')).resolves.toBeNull();
  });

  it('區間讀取送出 Range 標頭', async () => {
    const { calls, hub } = client([bytes(Buffer.from('234'), 206)]);
    await hub.readRange('a.txt', { end: 4, start: 2 });
    expect(calls[0]?.headers.range).toBe('bytes=2-4');
  });

  it('區間讀取回傳伺服器給的片段', async () => {
    const { hub } = client([bytes(Buffer.from('234'), 206)]);
    const slice = await hub.readRange('a.txt', { end: 4, start: 2 });
    expect(slice.toString('utf8')).toBe('234');
  });

  it('伺服器忽略 Range 回 200 時自行切出所求區間', async () => {
    const { hub } = client([bytes(Buffer.from('0123456789'), 200)]);
    const slice = await hub.readRange('a.txt', { end: 4, start: 2 });
    expect(slice.toString('utf8')).toBe('234');
  });

  it('區間讀取讀不到檔案時拋錯而非回傳空值', async () => {
    const { hub } = client([fail(404)]);
    await expect(hub.readRange('missing.txt', { end: 1, start: 0 })).rejects.toThrow(HubError);
  });

  it('讀取不帶權杖時仍可取得公開檔案', async () => {
    const { calls, hub } = client([bytes(Buffer.from('x'))], { token: null });
    await hub.readAll('a.txt');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('取得檔案大小以 content-length 回報', async () => {
    const response = new Response(null, { headers: { 'content-length': '4096' }, status: 200 });
    const { calls, hub } = client([response]);
    await expect(hub.statFile('a.pack')).resolves.toBe(4096);
    expect(calls[0]?.method).toBe('HEAD');
  });

  it('檔案不存在時大小回報為 null', async () => {
    const { hub } = client([fail(404)]);
    await expect(hub.statFile('missing')).resolves.toBeNull();
  });
});

describe('HuggingFace 重試與限流', () => {
  it('429 之後重試並成功', async () => {
    const { calls, hub } = client([fail(429), bytes(Buffer.from('ok'))]);
    const result = await hub.readAll('a.txt');
    expect(result?.toString('utf8')).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('尊重 Retry-After 指定的秒數', async () => {
    const { hub, sleep } = client([fail(429, { 'retry-after': '3' }), bytes(Buffer.from('ok'))]);
    await hub.readAll('a.txt');
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('沒有 Retry-After 時採退避等待', async () => {
    const { hub, sleep } = client([fail(503), bytes(Buffer.from('ok'))]);
    await hub.readAll('a.txt');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it('用戶端錯誤不重試', async () => {
    const { calls, hub } = client([fail(400)]);
    await expect(hub.readAll('a.txt')).rejects.toThrow(HubError);
    expect(calls).toHaveLength(1);
  });

  it('持續限流時在上限次數後放棄', async () => {
    const { calls, hub } = client([fail(429)]);
    await expect(hub.readAll('a.txt')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it('上傳也套用同一套重試策略', async () => {
    const { calls, hub } = client([fail(500), ok()]);
    await hub.putFile('a.txt', Buffer.from('x'));
    expect(calls).toHaveLength(2);
  });
});

describe('HuggingFace 權杖不外洩', () => {
  it('錯誤訊息不含權杖', async () => {
    const { hub } = client([fail(403)]);
    await expect(hub.putFile('a.txt', Buffer.from('x'))).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }) as Error,
    );
  });

  it('錯誤訊息不夾帶上游回應內容', async () => {
    const { hub } = client([fail(403)]);
    let message = '';
    try {
      await hub.putFile('a.txt', Buffer.from('x'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('upstream rejected');
  });
});
