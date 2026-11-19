/**
 * 執行期組裝：把組態轉成可用的加密儲存層與啟動輔助。
 *
 * 功能位置：
 * - createStoreFromConfig : 行 24 — Hub 客戶端 + 加密 Store 兩層組裝
 * - tuneSqlite           : 行 39 — 切換 SQLite 至 WAL（讀寫不互斥）
 * - SHUTDOWN_SIGNALS      : 行 46 — 容器關機訊號
 * - startupBanner         : 行 52 — 啟動訊息（只含位址與模式）
 *
 * 之所以把這些抽出 server.ts：server.ts 只負責副作用（listen、訊號、程序結束碼），
 * 這裡則是可直接單元測試的純組裝邏輯。
 */

import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/schema.js';
import { createHubClient } from '../storage/hf.js';
import { createHubStore, type Store } from '../storage/store.js';

export function createStoreFromConfig(config: AppConfig): Store {
  const hub = createHubClient({
    repoId: config.storage.datasetId,
    revision: config.storage.revision,
    token: config.storage.token,
    lfsThresholdBytes: config.storage.lfsThresholdBytes,
  });
  return createHubStore({
    hub,
    masterKey: config.storage.encryptionKey,
    cacheMaxBytes: config.cache.maxBytes,
  });
}

/**
 * 預設的 DELETE 日誌模式會讓讀取與寫入互斥；本服務的查詢大量並行（守門、
 * 物件索引批量解析），WAL 讓讀者在寫入進行時仍能前進。busy_timeout 由
 * Prisma 引擎設定，此處不再重設。
 */
export async function tuneSqlite(prisma: PrismaClient): Promise<void> {
  // PRAGMA 會回傳結果列，必須走 queryRaw 而非 executeRaw。
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
}

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * 啟動訊息刻意只引用位址與註冊模式。
 * 組態裡有存取權杖與加密主金鑰，整個物件印出去會進日誌。
 */
export function startupBanner(config: AppConfig): string {
  const { host, port } = config.server;
  return `onedrive-github listening on http://${host}:${port} (registration: ${config.registration.mode})`;
}
