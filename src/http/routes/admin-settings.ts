/**
 * 管理員設定端點（註冊模式切換）。
 *
 * 功能位置：
 * - GET   /api/admin/settings : 行 24 — 讀取目前生效的註冊模式
 * - PATCH /api/admin/settings : 行 30 — 切換註冊模式並持久化
 *
 * 設定寫入 Setting 表後立即生效，不需重啟；非法值一律回 invalid_mode 且不改動現狀。
 */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { RegistrationMode } from '../../config/schema.js';
import { readRegistrationMode, writeRegistrationMode } from '../../settings/registration.js';
import { sendError } from '../errors.js';
import { asRecord } from '../payload.js';
import { requireAdmin } from '../principal.js';

export interface AdminSettingsDeps {
  prisma: PrismaClient;
  fallbackMode: RegistrationMode;
}

export function registerAdminSettingsRoutes(app: FastifyInstance, deps: AdminSettingsDeps): void {
  const { prisma, fallbackMode } = deps;

  app.get('/api/admin/settings', async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return reply;
    return reply.send({ registrationMode: await readRegistrationMode(prisma, fallbackMode) });
  });

  app.patch('/api/admin/settings', async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return reply;

    const { registrationMode } = asRecord(request.body);
    if (!(await writeRegistrationMode(prisma, registrationMode))) {
      return sendError(reply, 400, 'invalid_mode');
    }
    return reply.send({ registrationMode: await readRegistrationMode(prisma, fallbackMode) });
  });
}
