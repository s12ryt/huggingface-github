/**
 * HTTP 測試輔助。
 * - createTestApp：組裝「隔離 SQLite + 指定註冊模式」的 Fastify 實例（第 30 行）
 * - testEnv：產生通過 config 驗證的最小 env（第 20 行）
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

import { loadConfig } from '@/config/load.js';
import { buildApp } from '@/http/app.js';
import type { Store } from '@/storage/store.js';

import { createTestDb } from './db.js';
import { createFakeStore } from './store.js';

export type TestRegistrationMode = 'open' | 'invite' | 'closed';

export interface TestAppOptions {
  registrationMode?: TestRegistrationMode;
  rateLimitMax?: number;
  store?: Store;
}

function testEnv(mode: TestRegistrationMode): Record<string, string> {
  return {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters',
    REGISTRATION_MODE: mode,
    HF_DATASET_ID: 'acme/test-store',
    STORAGE_ENCRYPTION_KEY: 'a'.repeat(64),
  };
}

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  store: Store;
  close(): Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const db = createTestDb();
  const config = loadConfig(testEnv(options.registrationMode ?? 'open'));
  const store = options.store ?? (createFakeStore() as unknown as Store);
  const app = await buildApp({
    config,
    prisma: db.prisma,
    store,
    rateLimitMax: options.rateLimitMax ?? 10_000,
  });

  return {
    app,
    prisma: db.prisma,
    store,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
