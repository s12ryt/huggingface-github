/**
 * Fastify 應用組裝。
 *
 * 功能位置：
 * - BuildAppOptions : 行 29 — 注入設定、Prisma、速率上限
 * - buildApp()      : 行 37 — 插件註冊與路由掛載
 *
 * 註冊模式的路由層行為：
 * 模式存於 Setting 表（未設定時回落到環境組態），管理員切換後立即生效。
 * POST /api/auth/register 一律掛載，但在 closed 模式下回傳與「路徑不存在」
 * 逐位元組相同的 404，因此腳本無法藉由回應差異判斷註冊是否開放。
 * GET /api/auth/registration 在三種模式下都存在，只回傳 { mode }，
 * 讓前端決定是否渲染註冊頁。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/schema.js';
import type { Store } from '../storage/store.js';
import { readRegistrationMode } from '../settings/registration.js';
import { isSecureOrigin } from './cookies.js';
import { notFoundHandler } from './errors.js';
import { registerAdminInviteRoutes } from './routes/admin-invites.js';
import { registerAdminSettingsRoutes } from './routes/admin-settings.js';
import { registerGitRoutes } from './routes/git.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerPasswordRoutes } from './routes/password.js';
import { registerPullRoutes } from './routes/pulls.js';
import { registerRegisterRoutes } from './routes/register.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerWebRoutes } from './routes/web.js';

export interface BuildAppOptions {
  config: AppConfig;
  prisma: PrismaClient;
  store: Store;
  rateLimitMax?: number;
}

const DEFAULT_RATE_LIMIT_MAX = 20;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, prisma, store } = options;
  const rateLimitMax = options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const secureCookie = isSecureOrigin(config.server.publicUrl);
  const fallbackMode = config.registration.mode;
  const resolveMode = () => readRegistrationMode(prisma, fallbackMode);

  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(cookie, { secret: config.security.sessionSecret });
  await app.register(rateLimit, { global: false, max: rateLimitMax, timeWindow: '1 minute' });

  app.setNotFoundHandler(notFoundHandler);

  app.get('/api/auth/registration', async () => ({ mode: await resolveMode() }));

  registerSessionRoutes(app, { prisma, secureCookie, rateLimitMax });
  registerPasswordRoutes(app, { prisma, rateLimitMax });
  registerTokenRoutes(app, { prisma });
  registerRegisterRoutes(app, { prisma, secureCookie, rateLimitMax, resolveMode });
  registerAdminInviteRoutes(app, { prisma });
  registerAdminSettingsRoutes(app, { prisma, fallbackMode });
  registerRepoRoutes(app, { prisma, publicUrl: config.server.publicUrl });
  registerIssueRoutes(app, { prisma, store });
  registerPullRoutes(app, { prisma, store });
  registerGitRoutes(app, { prisma, store });
  registerWebRoutes(app, { resolveMode });

  return app;
}
