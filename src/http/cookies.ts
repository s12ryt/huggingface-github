/**
 * 工作階段 cookie 設定。
 *
 * 功能位置：
 * - SESSION_COOKIE_NAME   : 行 17 — cookie 名稱
 * - isSecureOrigin()      : 行 19 — 依 publicUrl 判定是否標記 Secure
 * - sessionCookieOptions(): 行 23 — 簽發用設定
 * - clearedCookieOptions(): 行 33 — 登出用設定
 *
 * 安全不變量：httpOnly 阻斷 JS 讀取、sameSite strict 阻斷跨站送出、
 * path 固定為 '/' 讓 git 子路徑也能帶上。
 */

import type { CookieSerializeOptions } from '@fastify/cookie';

export const SESSION_COOKIE_NAME = 'odg_session';

export function isSecureOrigin(publicUrl: string): boolean {
  return publicUrl.toLowerCase().startsWith('https://');
}

export function sessionCookieOptions(expires: Date, secure: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    expires,
  };
}

export function clearedCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    maxAge: 0,
  };
}
