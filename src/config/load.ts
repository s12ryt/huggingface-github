/**
 * 從環境變數載入並驗證全站設定。
 *
 * 功能索引：
 *   - loadConfig      : 讀取 -> 驗證 -> 正規化 -> 深度凍結。L31
 *   - readEnumMode    : 大小寫不敏感、去空白的列舉解析。L74
 *   - readStorage     : HuggingFace 資料集與加密主金鑰。L88
 *   - readMasterKey   : 金鑰解析，失敗只回報欄位名不回報值。L106
 *
 * 設計約束：
 *   - REGISTRATION_MODE 未設定時預設 closed（安全預設，避免意外開放註冊）
 *   - 所有缺失一次回報，不逐項中斷
 *   - 錯誤訊息永不含設定值
 *   - deepFreeze 會跳過 Buffer，主金鑰以 Buffer 形式保留
 */

import { parseMasterKey } from '../storage/crypto.js';
import {
  DEFAULTS,
  REGISTRATION_MODES,
  type AppConfig,
  type RegistrationMode,
  type StorageConfig,
} from './schema.js';
import { parseByteSize, parsePort } from './units.js';
import { Issues, deepFreeze } from './validate.js';

export type EnvSource = Record<string, string | undefined>;

export function loadConfig(source: EnvSource = process.env): AppConfig {
  const issues = new Issues();

  const registrationMode =
    readEnumMode(issues, 'REGISTRATION_MODE', source.REGISTRATION_MODE, REGISTRATION_MODES) ??
    DEFAULTS.registrationMode;

  const sessionSecret = source.SESSION_SECRET?.trim() ?? '';
  if (sessionSecret.length < DEFAULTS.sessionSecretMinLength) {
    issues.add('SESSION_SECRET', `must be at least ${DEFAULTS.sessionSecretMinLength} characters`);
  }

  const port = readPort(issues, source.PORT);
  const cacheMaxBytes = readSize(
    issues,
    'CACHE_MAX_BYTES',
    source.CACHE_MAX_BYTES,
    DEFAULTS.cacheMaxBytes,
  );
  const storage = readStorage(issues, source);

  issues.throwIfAny();

  return deepFreeze<AppConfig>({
    server: {
      host: source.HOST?.trim() || DEFAULTS.host,
      port,
      publicUrl: stripTrailingSlash(source.PUBLIC_URL?.trim() || DEFAULTS.publicUrl),
    },
    registration: { mode: registrationMode satisfies RegistrationMode },
    storage,
    cache: { maxBytes: cacheMaxBytes },
    security: { sessionSecret },
  });
}

function readPort(issues: Issues, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULTS.port;
  const port = parsePort(raw);
  if (port === null) {
    issues.add('PORT', 'must be an integer between 1 and 65535');
    return DEFAULTS.port;
  }
  return port;
}

function readSize(
  issues: Issues,
  key: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const bytes = parseByteSize(raw);
  if (bytes === null) {
    issues.add(key, 'must be a positive size such as 1024, 512MB or 2GB');
    return fallback;
  }
  return bytes;
}

function readEnumMode<T extends string>(
  issues: Issues,
  key: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    issues.oneOf(key, allowed);
    return undefined;
  }
  return value as T;
}

function readStorage(issues: Issues, source: EnvSource): StorageConfig {
  const token = source.HF_TOKEN?.trim() ?? '';

  return {
    datasetId: issues.require('HF_DATASET_ID', source.HF_DATASET_ID),
    revision: source.HF_REVISION?.trim() || DEFAULTS.hfRevision,
    token: token === '' ? null : token,
    encryptionKey: readMasterKey(issues, source.STORAGE_ENCRYPTION_KEY),
    lfsThresholdBytes: readSize(
      issues,
      'LFS_THRESHOLD_BYTES',
      source.LFS_THRESHOLD_BYTES,
      DEFAULTS.lfsThresholdBytes,
    ),
  };
}

/**
 * 金鑰解析失敗只回報欄位名與格式要求。
 * 這裡刻意不轉述 parseMasterKey 的例外訊息，也不回報長度，
 * 以免把金鑰片段或其長度寫進日誌。
 */
function readMasterKey(issues: Issues, raw: string | undefined): Buffer {
  const value = raw?.trim() ?? '';
  if (value === '') {
    issues.add('STORAGE_ENCRYPTION_KEY', 'is required');
    return Buffer.alloc(32);
  }
  try {
    return parseMasterKey(value);
  } catch {
    issues.add(
      'STORAGE_ENCRYPTION_KEY',
      'must be 32 bytes encoded as 64 hex characters or base64',
    );
    return Buffer.alloc(32);
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
