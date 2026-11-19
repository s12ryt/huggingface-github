/**
 * src/auth/tokens.ts — 不透明憑證的生成、雜湊與定時安全比較（階段 3）
 *
 * 1~25  SESSION_TOKEN_PREFIX / PAT_TOKEN_PREFIX：可辨識來源的 token 前綴
 * 26~45 createSecretToken：32 位元組熵，回傳明文、sha256 雜湊、顯示前綴
 * 46~55 hashSecretToken：資料庫只存此雜湊，明文僅簽發當下回傳一次
 * 56~65 tokenDisplayPrefix：供 UI 辨識用的非敏感片段
 * 66~   timingSafeEqualHex：長度或字元集不符一律回 false，不拋錯
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_PREFIX = 'odgs';
export const PAT_TOKEN_PREFIX = 'odgp';

const SECRET_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 12;
const HEX_PATTERN = /^[0-9a-f]*$/;

export interface SecretToken {
  token: string;
  tokenHash: string;
  displayPrefix: string;
}

export function hashSecretToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

export function createSecretToken(prefix: string): SecretToken {
  const token = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return {
    token,
    tokenHash: hashSecretToken(token),
    displayPrefix: tokenDisplayPrefix(token),
  };
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
