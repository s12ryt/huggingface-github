/**
 * 設定驗證的共用原語。
 *
 * 功能索引：
 *   - ConfigError : 聚合所有設定問題的錯誤型別。L16
 *   - Issues      : 問題收集器，一次回報全部缺失，且不輸出設定值本身。L31
 *   - deepFreeze  : 遞迴凍結設定樹，防止執行期被改寫。L58
 *
 * 安全不變量：錯誤訊息只含「變數名 + 原因」，永不含實際值（避免密鑰外洩）。
 */

export interface ConfigIssue {
  key: string;
  reason: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.key}: ${issue.reason}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** 收集設定問題；有任何問題時一次拋出。 */
export class Issues {
  private readonly items: ConfigIssue[] = [];

  add(key: string, reason: string): void {
    this.items.push({ key, reason });
  }

  /** 要求必填字串，缺失時記錄問題並回傳空字串以便繼續收集其他問題。 */
  require(key: string, value: string | undefined): string {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') this.add(key, 'is required');
    return trimmed;
  }

  oneOf(key: string, allowed: readonly string[]): void {
    this.add(key, `must be one of ${allowed.join(', ')}`);
  }

  throwIfAny(): void {
    if (this.items.length > 0) throw new ConfigError(this.items);
  }
}

/**
 * 遞迴凍結物件樹。
 *
 * 位元組緩衝區（如加密主金鑰）必須跳過：Object.freeze 對帶有元素的
 * TypedArray 會拋 TypeError，而設定樹本身已凍結，無法被換成另一把金鑰。
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
