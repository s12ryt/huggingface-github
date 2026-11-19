/**
 * 應用設定的型別與合法值。
 *
 * 功能索引：
 *   - REGISTRATION_MODES / RegistrationMode : 註冊三模式（open / invite / closed）。L21
 *   - StorageConfig                         : HuggingFace 公共資料集 + 加密主金鑰。L29
 *   - AppConfig                             : 全站設定樹。L36
 *   - DEFAULTS                              : 安全預設值（註冊預設 closed）。L54
 *
 * 設計約束：
 *   儲存後端是公開的 HuggingFace 資料集，任何人都能下載檔案，
 *   因此 encryptionKey 不是選項而是必填：沒有金鑰就沒有機密性。
 */

/**
 * open   = 開放註冊（用戶名 + 密碼 + 密碼確認）
 * invite = 僅邀請碼註冊
 * closed = 關閉註冊，註冊端點必須與不存在的路徑無法區分
 */
export const REGISTRATION_MODES = ['open', 'invite', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

/**
 * token 為 null 時只能讀取公開內容；寫入（commit API）必須有權杖。
 * encryptionKey 是全站主金鑰，每個檔案再以 HKDF 依路徑衍生子金鑰。
 * lfsThresholdBytes 以上的檔案改走 Git LFS；LFS 副檔名不論大小一律走 LFS。
 */
export interface StorageConfig {
  datasetId: string;
  revision: string;
  token: string | null;
  encryptionKey: Buffer;
  lfsThresholdBytes: number;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    publicUrl: string;
  };
  registration: {
    mode: RegistrationMode;
  };
  storage: StorageConfig;
  cache: {
    maxBytes: number;
  };
  security: {
    sessionSecret: string;
  };
}

export const DEFAULTS = {
  host: '0.0.0.0',
  port: 3000,
  publicUrl: 'http://localhost:3000',
  registrationMode: 'closed' satisfies RegistrationMode,
  hfRevision: 'main',
  lfsThresholdBytes: 10 * 1024 ** 2,
  cacheMaxBytes: 2 * 1024 ** 3,
  sessionSecretMinLength: 32,
} as const;
