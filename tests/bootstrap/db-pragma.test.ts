/**
 * SQLite 連線參數測試：WAL 與 busy_timeout 必須在建立用戶端時啟用。
 *
 * WAL 讀寫不互斥，是並行查詢（R7~R14 引入）在寫入發生時不被鎖住的前提；
 * busy_timeout 讓鎖競爭以等待化解而非直接拋 SQLITE_BUSY。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../helpers/db.js';

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.close();
});

interface PragmaRow {
  [key: string]: unknown;
}

function valueOf(rows: PragmaRow[], key: string): unknown {
  return rows[0]?.[key];
}

describe('SQLite 連線參數', () => {
  it('啟用 WAL 日誌模式', async () => {
    const rows = (await db.prisma.$queryRawUnsafe('PRAGMA journal_mode;')) as PragmaRow[];
    expect(String(valueOf(rows, 'journal_mode')).toLowerCase()).toBe('wal');
  });

  it('設定 busy_timeout', async () => {
    const rows = (await db.prisma.$queryRawUnsafe('PRAGMA busy_timeout;')) as PragmaRow[];
    expect(Number(valueOf(rows, 'timeout'))).toBeGreaterThanOrEqual(5000);
  });
});
