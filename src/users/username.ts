/**
 * 使用者名稱規則。
 * - USERNAME_PATTERN / RESERVED_USERNAMES：格式與保留字清單（第 13、18 行）
 * - normalizeUsername：正規化為小寫並拒絕非法與保留名稱（第 40 行）
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/** 首尾必須是英數，中間允許連字號與底線。 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/;

/**
 * 保留名稱：避免使用者名稱與路由前綴或系統端點撞名。
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'about',
  'admin-api',
  'api',
  'assets',
  'auth',
  'favicon',
  'help',
  'login',
  'logout',
  'me',
  'new',
  'pulls',
  'register',
  'repos',
  'settings',
  'signup',
  'static',
  'issues',
]);

export type UsernameErrorCode = 'invalid_username' | 'reserved_username';

export class UsernameError extends Error {
  constructor(readonly code: UsernameErrorCode) {
    super(`Username rejected: ${code}`);
    this.name = 'UsernameError';
  }
}

export function normalizeUsername(input: unknown): string {
  if (typeof input !== 'string') throw new UsernameError('invalid_username');

  const username = input.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new UsernameError('invalid_username');
  if (RESERVED_USERNAMES.has(username)) throw new UsernameError('reserved_username');

  return username;
}
