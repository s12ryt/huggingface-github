import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/load.js';
import { DEFAULTS } from '@/config/schema.js';

const KEY_HEX = 'a'.repeat(64);

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SESSION_SECRET: 's'.repeat(40),
    HF_DATASET_ID: 'acme/git-store',
    STORAGE_ENCRYPTION_KEY: KEY_HEX,
    ...overrides,
  };
}

describe('註冊模式', () => {
  it('未設定時預設為關閉註冊', () => {
    expect(loadConfig(env()).registration.mode).toBe('closed');
  });

  it.each(['open', 'invite', 'closed'] as const)('接受 %s', (mode) => {
    expect(loadConfig(env({ REGISTRATION_MODE: mode })).registration.mode).toBe(mode);
  });

  it('非法值的錯誤訊息列出三種合法模式', () => {
    try {
      loadConfig(env({ REGISTRATION_MODE: 'half-open' }));
      expect.unreachable('應拋出設定錯誤');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('open');
      expect(message).toContain('invite');
      expect(message).toContain('closed');
    }
  });

  it('大小寫不敏感且去除空白', () => {
    expect(loadConfig(env({ REGISTRATION_MODE: ' OPEN ' })).registration.mode).toBe('open');
  });
});

describe('HuggingFace 儲存後端', () => {
  it('帶出資料集代號', () => {
    expect(loadConfig(env()).storage.datasetId).toBe('acme/git-store');
  });

  it('缺少資料集代號時拒絕啟動', () => {
    expect(() => loadConfig(env({ HF_DATASET_ID: undefined }))).toThrow(/HF_DATASET_ID/);
  });

  it('修訂版本未設定時預設為 main', () => {
    expect(loadConfig(env()).storage.revision).toBe(DEFAULTS.hfRevision);
    expect(DEFAULTS.hfRevision).toBe('main');
  });

  it('修訂版本可自訂', () => {
    expect(loadConfig(env({ HF_REVISION: 'dev' })).storage.revision).toBe('dev');
  });

  it('未提供權杖時為 null，代表只能讀取公開內容', () => {
    expect(loadConfig(env()).storage.token).toBeNull();
  });

  it('提供權杖時原樣保留', () => {
    expect(loadConfig(env({ HF_TOKEN: 'hf_abc' })).storage.token).toBe('hf_abc');
  });

  it('空白權杖視為未提供', () => {
    expect(loadConfig(env({ HF_TOKEN: '   ' })).storage.token).toBeNull();
  });

  it('資料集代號去除前後空白', () => {
    expect(loadConfig(env({ HF_DATASET_ID: '  acme/git-store  ' })).storage.datasetId).toBe(
      'acme/git-store',
    );
  });

  it('LFS 門檻預設為 10 MiB', () => {
    expect(loadConfig(env()).storage.lfsThresholdBytes).toBe(DEFAULTS.lfsThresholdBytes);
    expect(DEFAULTS.lfsThresholdBytes).toBe(10 * 1024 * 1024);
  });

  it('LFS 門檻可用尺寸字串覆寫', () => {
    expect(
      loadConfig(env({ LFS_THRESHOLD_BYTES: '512MB' })).storage.lfsThresholdBytes,
    ).toBe(512 * 1024 * 1024);
  });

  it('無法解析的 LFS 門檻拒絕啟動', () => {
    expect(() => loadConfig(env({ LFS_THRESHOLD_BYTES: 'huge' }))).toThrow(
      /LFS_THRESHOLD_BYTES/,
    );
  });
});

describe('儲存加密金鑰', () => {
  it('解析為 32 位元組的主金鑰', () => {
    const key = loadConfig(env()).storage.encryptionKey;
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
  });

  it('接受 base64 編碼的金鑰', () => {
    const raw = Buffer.alloc(32, 7);
    const key = loadConfig(env({ STORAGE_ENCRYPTION_KEY: raw.toString('base64') })).storage
      .encryptionKey;
    expect(key.equals(raw)).toBe(true);
  });

  it('缺少金鑰時拒絕啟動', () => {
    expect(() => loadConfig(env({ STORAGE_ENCRYPTION_KEY: undefined }))).toThrow(
      /STORAGE_ENCRYPTION_KEY/,
    );
  });

  it.each(['too-short', 'a'.repeat(63), 'a'.repeat(66), '!!!!'])(
    '拒絕長度或編碼不合法的金鑰 %s',
    (value) => {
      expect(() => loadConfig(env({ STORAGE_ENCRYPTION_KEY: value }))).toThrow(
        /STORAGE_ENCRYPTION_KEY/,
      );
    },
  );

  it('金鑰不合法時的錯誤訊息不得含金鑰內容', () => {
    const secret = 'z'.repeat(70);
    try {
      loadConfig(env({ STORAGE_ENCRYPTION_KEY: secret }));
      expect.unreachable('應拋出設定錯誤');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('快取與安全', () => {
  it('快取上限預設 2GB', () => {
    expect(loadConfig(env()).cache.maxBytes).toBe(2 * 1024 ** 3);
  });

  it.each([
    ['1024', 1024],
    ['512MB', 512 * 1024 ** 2],
    ['2GB', 2 * 1024 ** 3],
    ['1.5gb', 1.5 * 1024 ** 3],
    ['64 KB', 64 * 1024],
  ])('解析快取上限 %s', (raw, expected) => {
    expect(loadConfig(env({ CACHE_MAX_BYTES: raw as string })).cache.maxBytes).toBe(expected);
  });

  it('無法解析的快取上限拒絕啟動', () => {
    expect(() => loadConfig(env({ CACHE_MAX_BYTES: 'plenty' }))).toThrow(/CACHE_MAX_BYTES/);
  });

  it('工作階段密鑰短於 32 字元時拒絕啟動', () => {
    expect(() => loadConfig(env({ SESSION_SECRET: 'short' }))).toThrow(/SESSION_SECRET/);
  });

  it('連接埠非數字時拒絕啟動', () => {
    expect(() => loadConfig(env({ PORT: 'eighty' }))).toThrow(/PORT/);
  });

  it('連接埠預設 3000 且可覆寫', () => {
    expect(loadConfig(env()).server.port).toBe(3000);
    expect(loadConfig(env({ PORT: '8080' })).server.port).toBe(8080);
  });

  it('對外網址去除尾斜線', () => {
    expect(loadConfig(env({ PUBLIC_URL: 'https://git.example.com/' })).server.publicUrl).toBe(
      'https://git.example.com',
    );
  });
});

describe('不可變性與錯誤聚合', () => {
  it('設定物件被深度凍結', () => {
    const config = loadConfig(env());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.storage)).toBe(true);
    expect(Object.isFrozen(config.server)).toBe(true);
  });

  it('多個欄位有問題時一次回報全部', () => {
    try {
      loadConfig({ SESSION_SECRET: 'short', PORT: 'eighty' });
      expect.unreachable('應拋出設定錯誤');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SESSION_SECRET');
      expect(message).toContain('PORT');
      expect(message).toContain('HF_DATASET_ID');
      expect(message).toContain('STORAGE_ENCRYPTION_KEY');
    }
  });

  it('錯誤訊息不得含密鑰值', () => {
    const secret = 'leak-me-please';
    try {
      loadConfig(env({ SESSION_SECRET: secret }));
      expect.unreachable('應拋出設定錯誤');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
