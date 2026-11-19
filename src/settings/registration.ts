// 註冊模式的執行期讀寫（以 Setting 表持久化）
//   REGISTRATION_MODE_KEY — 設定鍵名（第 12 行）
//   isRegistrationMode    — 嚴格比對合法模式，不做 trim 或大小寫寬容（第 14 行）
//   readRegistrationMode  — 讀取；無紀錄或值已損壞時回落到環境組態（第 18 行）
//   writeRegistrationMode — 寫入；非法值一律拒絕並回 false，成功後使快取失效（第 33 行）
import type { PrismaClient } from '@prisma/client';
import { REGISTRATION_MODES, type RegistrationMode } from '../config/schema.js';

export const REGISTRATION_MODE_KEY = 'registration.mode';

export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return typeof value === 'string' && (REGISTRATION_MODES as readonly string[]).includes(value);
}

/**
 * 每個請求都會讀模式（/login、/register、/api/auth/registration），但值只在管理員
 * 切換時變動。以 prisma 實例為鍵快取已解析的模式，寫入時失效，使「切換後立即生效」
 * 不變；用 WeakMap 是為了測試環境多個資料庫實例不互相污染。
 */
const modeCache = new WeakMap<PrismaClient, RegistrationMode>();

export async function readRegistrationMode(
  prisma: PrismaClient,
  fallback: RegistrationMode,
): Promise<RegistrationMode> {
  const cached = modeCache.get(prisma);
  if (cached !== undefined) return cached;
  const row = await prisma.setting.findUnique({ where: { key: REGISTRATION_MODE_KEY } });
  const mode = isRegistrationMode(row?.value) ? row.value : fallback;
  modeCache.set(prisma, mode);
  return mode;
}

export async function writeRegistrationMode(prisma: PrismaClient, value: unknown): Promise<boolean> {
  if (!isRegistrationMode(value)) return false;
  await prisma.setting.upsert({
    where: { key: REGISTRATION_MODE_KEY },
    update: { value },
    create: { key: REGISTRATION_MODE_KEY, value },
  });
  modeCache.delete(prisma);
  return true;
}
