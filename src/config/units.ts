/**
 * 設定值單位解析。
 *
 * 功能索引：
 *   - parseByteSize  : 人類可讀位元組大小 -> number（"2GB" / "512MB" / "1024"）。L25
 *   - parsePort      : 連接埠字串 -> number（1..65535）。L41
 */

const BYTE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
} as const;

const BYTE_SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i;

/** 解析位元組大小，無法解析或非正數時回傳 null。 */
export function parseByteSize(raw: string): number | null {
  const matched = BYTE_SIZE.exec(raw.trim());
  if (!matched) return null;

  const unit = (matched[2] ?? 'b').toLowerCase() as keyof typeof BYTE_UNITS;
  const bytes = Number(matched[1]) * BYTE_UNITS[unit];

  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/** 解析連接埠，非法時回傳 null。 */
export function parsePort(raw: string): number | null {
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
