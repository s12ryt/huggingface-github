/**
 * 執行期組裝的驗收測試。
 * - createStoreFromConfig：由組態組出可用的加密儲存層（第 24 行）
 * - 關機訊號與啟動訊息：不得洩漏權杖或主金鑰（第 71 行）
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '@/config/load.js';
import { SHUTDOWN_SIGNALS, createStoreFromConfig, startupBanner } from '@/bootstrap/runtime.js';

const TOKEN = 'hf_secret_token_value';

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SESSION_SECRET: 's'.repeat(40),
    HF_DATASET_ID: 'acme/git-store',
    STORAGE_ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  };
}

describe('createStoreFromConfig', () => {
  it('以公開資料集組態組出儲存層', () => {
    const store = createStoreFromConfig(loadConfig(env()));
    expect(typeof store.readRanges).toBe('function');
    expect(typeof store.putBytes).toBe('function');
  });

  it('沒有權杖時仍可組出儲存層（唯讀公開內容）', () => {
    const config = loadConfig(env());
    expect(config.storage.token).toBeNull();
    expect(() => createStoreFromConfig(config)).not.toThrow();
  });

  it('有權杖時沿用該權杖組裝', () => {
    const config = loadConfig(env({ HF_TOKEN: TOKEN }));
    expect(config.storage.token).toBe(TOKEN);
    expect(() => createStoreFromConfig(config)).not.toThrow();
  });

  it('自訂修訂版本會被帶入', () => {
    const config = loadConfig(env({ HF_REVISION: 'refs/convert/parquet' }));
    expect(config.storage.revision).toBe('refs/convert/parquet');
    expect(() => createStoreFromConfig(config)).not.toThrow();
  });

  it('快取上限反映在儲存層統計上', () => {
    const store = createStoreFromConfig(loadConfig(env({ CACHE_MAX_BYTES: '64MB' })));
    expect(store.cacheStats().capacity).toBe(64 * 1024 * 1024);
  });

  // 組態層刻意拒絕 0：一個誤設成 0 的快取會讓每次讀取都回源，
  // 那是效能災難而不是合理設定，所以在啟動時就擋下來。
  it('快取上限 0 被組態層拒絕', () => {
    expect(() => loadConfig(env({ CACHE_MAX_BYTES: '0' }))).toThrow(/CACHE_MAX_BYTES/);
  });

  it('缺少加密主金鑰時拒絕啟動', () => {
    const broken = env();
    delete broken.STORAGE_ENCRYPTION_KEY;
    expect(() => loadConfig(broken)).toThrow(/STORAGE_ENCRYPTION_KEY/);
  });
});

describe('關機訊號與啟動訊息', () => {
  it('只處理容器會送出的兩個訊號', () => {
    expect([...SHUTDOWN_SIGNALS]).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('啟動訊息帶出埠號與註冊模式', () => {
    const banner = startupBanner(loadConfig(env({ PORT: '4321', REGISTRATION_MODE: 'invite' })));
    expect(banner).toContain('4321');
    expect(banner).toContain('invite');
  });

  it('啟動訊息不得洩漏權杖或工作階段密鑰', () => {
    const banner = startupBanner(loadConfig(env({ HF_TOKEN: TOKEN })));
    expect(banner).not.toContain(TOKEN);
    expect(banner).not.toContain('s'.repeat(40));
  });

  it('啟動訊息不得洩漏加密主金鑰', () => {
    const banner = startupBanner(loadConfig(env()));
    expect(banner).not.toContain('a'.repeat(64));
  });
});
