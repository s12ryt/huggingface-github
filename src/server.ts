/**
 * 行程入口：載入組態、建立 admin 種子帳號、啟動 HTTP 伺服器。
 *
 * 功能位置：
 * - main()  : 行 20 — 組裝與啟動
 * - 關機處理 : 行 36 — SIGINT / SIGTERM 下優雅關閉並斷開資料庫
 *
 * 可測邏輯都在 bootstrap/runtime.ts，本檔只保留副作用。
 */

import { PrismaClient } from '@prisma/client';
import { createStoreFromConfig, SHUTDOWN_SIGNALS, startupBanner, tuneSqlite } from './bootstrap/runtime.js';
import { loadConfig } from './config/load.js';
import { ensureAdminAccount } from './auth/bootstrap.js';
import { buildApp } from './http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  await tuneSqlite(prisma);
  const store = createStoreFromConfig(config);

  const seeded = await ensureAdminAccount(prisma);
  if (seeded.created) {
    console.log(`created default admin account "${seeded.username}" — change the password on first login`);
  }

  const app = await buildApp({ config, prisma, store });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown());
  }

  await app.listen({ host: config.server.host, port: config.server.port });
  console.log(startupBanner(config));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
