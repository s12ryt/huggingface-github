/**
 * 請求主體基礎檢查。
 *
 * 功能位置：
 * - isNonEmptyString() : 行 10 — 判定欄位為非空字串（trim 後）
 * - asRecord()         : 行 14 — 將未知主體安全轉為鍵值表
 */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
