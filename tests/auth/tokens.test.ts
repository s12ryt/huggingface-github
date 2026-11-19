/**
 * tests/auth/tokens.test.ts — 不透明 token 生成與雜湊驗收測試（階段 3）
 *
 * 1~40  生成：前綴格式、熵長度、互不重複
 * 41~80 雜湊：sha256 決定性、明文不可回推、長度固定
 * 81~   比較：timingSafeEqualHex 對長度不一與不同值皆回 false
 */
import { describe, expect, it } from 'vitest';
import {
  PAT_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  createSecretToken,
  hashSecretToken,
  timingSafeEqualHex,
  tokenDisplayPrefix,
} from '@/auth/tokens.js';

describe('token 生成', () => {
  it('session 與 PAT 使用可辨識且互異的前綴', () => {
    expect(SESSION_TOKEN_PREFIX).toBe('odgs');
    expect(PAT_TOKEN_PREFIX).toBe('odgp');
    expect(SESSION_TOKEN_PREFIX).not.toBe(PAT_TOKEN_PREFIX);
  });

  it('token 以前綴加底線開頭', () => {
    const { token } = createSecretToken(PAT_TOKEN_PREFIX);
    expect(token.startsWith('odgp_')).toBe(true);
  });

  it('token 熵部分至少 32 位元組（base64url 43 字元）', () => {
    const { token } = createSecretToken(PAT_TOKEN_PREFIX);
    const secret = token.slice('odgp_'.length);
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('連續生成 200 次互不重複', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(createSecretToken(SESSION_TOKEN_PREFIX).token);
    expect(seen.size).toBe(200);
  });

  it('同時回傳 token、tokenHash、displayPrefix 三者', () => {
    const result = createSecretToken(PAT_TOKEN_PREFIX);
    expect(Object.keys(result).sort()).toEqual(['displayPrefix', 'token', 'tokenHash']);
  });

  it('回傳的 tokenHash 與獨立雜湊同一 token 的結果一致', () => {
    const { token, tokenHash } = createSecretToken(PAT_TOKEN_PREFIX);
    expect(hashSecretToken(token)).toBe(tokenHash);
  });
});

describe('token 雜湊', () => {
  it('雜湊為 64 字元小寫十六進位（sha256）', () => {
    const hash = hashSecretToken('odgp_abc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('雜湊具決定性', () => {
    expect(hashSecretToken('odgp_abc')).toBe(hashSecretToken('odgp_abc'));
  });

  it('不同 token 產生不同雜湊', () => {
    expect(hashSecretToken('odgp_abc')).not.toBe(hashSecretToken('odgp_abd'));
  });

  it('雜湊絕不包含 token 明文', () => {
    const { token, tokenHash } = createSecretToken(PAT_TOKEN_PREFIX);
    expect(tokenHash.includes(token.slice(5))).toBe(false);
  });
});

describe('顯示用前綴', () => {
  it('只揭露前綴與少量熵，長度固定 12', () => {
    const { token, displayPrefix } = createSecretToken(PAT_TOKEN_PREFIX);
    expect(displayPrefix).toHaveLength(12);
    expect(token.startsWith(displayPrefix)).toBe(true);
  });

  it('tokenDisplayPrefix 對短字串不越界', () => {
    expect(tokenDisplayPrefix('odgp')).toBe('odgp');
  });
});

describe('定時安全比較', () => {
  it('相同十六進位字串回 true', () => {
    const hash = hashSecretToken('odgp_abc');
    expect(timingSafeEqualHex(hash, hash)).toBe(true);
  });

  it('不同值回 false', () => {
    expect(timingSafeEqualHex(hashSecretToken('a'), hashSecretToken('b'))).toBe(false);
  });

  it('長度不一致回 false 而不拋錯', () => {
    expect(timingSafeEqualHex('abcd', hashSecretToken('a'))).toBe(false);
  });

  it('非十六進位輸入回 false 而不拋錯', () => {
    expect(timingSafeEqualHex('zz', 'zz')).toBe(false);
  });
});
