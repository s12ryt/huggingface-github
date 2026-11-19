/**
 * Vitest globalSetup：為整個測試回合準備一份 template SQLite 資料庫。
 *
 * 功能實現位置：
 *   - runPrisma()  第 18 行：以指定 DATABASE_URL 執行 prisma CLI（有 timeout）
 *   - setup()      第 29 行：清空 tests/.tmp → prisma generate → db push 產出 template.db
 *   - teardown()   第 41 行：回合結束移除 tests/.tmp
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { TEMPLATE_DB, TEST_TMP_DIR, dbUrl } from '../helpers/db.js';

const CLI_TIMEOUT_MS = 180_000;
const PRISMA_CLI = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

function runPrisma(args: string[], databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI, ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    timeout: CLI_TIMEOUT_MS,
  });
}

export default async function setup(): Promise<void> {
  rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  mkdirSync(TEST_TMP_DIR, { recursive: true });

  const url = dbUrl(TEMPLATE_DB);
  runPrisma(['generate'], url);
  runPrisma(['db', 'push', '--skip-generate', '--accept-data-loss'], url);

  // WAL 記在資料庫檔頭：template 切成 WAL 後，每個複製出的測試資料庫自動繼承，
  // 讀寫不互斥，與生產端 tuneSqlite 的行為一致。
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
  } finally {
    await prisma.$disconnect();
  }
}

export function teardown(): void {
  rmSync(TEST_TMP_DIR, { recursive: true, force: true });
}
