/**
 * 測試用 SQLite 資料庫輔助。
 *
 * 功能實現位置：
 *   - TEST_TMP_DIR / TEMPLATE_DB  第 20~22 行：測試暫存目錄與 template 資料庫路徑
 *   - dbUrl()                     第 28 行：絕對路徑轉 Prisma SQLite 連線字串（Windows 需正斜線）
 *   - createTestDb()              第 38 行：複製 template 取得隔離資料庫 + PrismaClient + close()
 *
 * 設計理由：每個測試檔複製一份 template.db（SQLite 單檔，複製為毫秒級），
 * 比每檔重跑 `prisma db push` 快兩個數量級，且測試之間完全隔離。
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

export const TEST_TMP_DIR = join(process.cwd(), 'tests', '.tmp');
export const TEMPLATE_DB = join(TEST_TMP_DIR, 'template.db');

export function dbUrl(file: string): string {
  return `file:${file.replace(/\\/g, '/')}`;
}

export interface TestDb {
  prisma: PrismaClient;
  close(): Promise<void>;
}

export function createTestDb(): TestDb {
  mkdirSync(TEST_TMP_DIR, { recursive: true });
  const file = join(TEST_TMP_DIR, `${randomUUID()}.db`);
  cpSync(TEMPLATE_DB, file);

  const prisma = new PrismaClient({ datasourceUrl: dbUrl(file) });
  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      rmSync(file, { force: true });
    },
  };
}
