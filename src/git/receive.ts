/**
 * 推送入庫：把收到的 packfile 與 ref 指令落盤。
 *
 * 功能位置：
 * - storePack()    : 行 30 — 掃描 pack、雙存索引（儲存桶 權威 + SQLite 快取）
 * - applyCommands(): 行 52 — 依 oldOid 樂觀比對後更新或刪除 ref
 *
 * ref 更新以 oldOid 作為樂觀鎖：不符即回報 ng，避免併發推送互相覆寫。
 */
import type { PrismaClient } from '@prisma/client';

import { scanPack } from '../git/pack.js';
import { writeIndex, type IndexStoreIo } from '../git/index-store.js';
import { ZERO_OID, type PushCommand, type RefResult } from '../git/protocol.js';

export interface ReceiveTarget {
  repoId: string;
  repoPath: string;
}

export interface StoredPack {
  objectCount: number;
  packName: string;
}

function packName(now: Date): string {
  return `pack-${now.getTime().toString(16)}-${Math.random().toString(16).slice(2, 10)}.pack`;
}

export async function storePack(
  prisma: PrismaClient,
  store: IndexStoreIo,
  target: ReceiveTarget,
  pack: Buffer,
): Promise<StoredPack | null> {
  const scan = scanPack(pack);
  if (scan.objectCount === 0) return null;

  const name = packName(new Date());
  await writeIndex(prisma, store, {
    pack,
    packName: name,
    repoId: target.repoId,
    repoPath: target.repoPath,
    scan,
  });

  return { objectCount: scan.objectCount, packName: name };
}

export async function applyCommands(
  prisma: PrismaClient,
  repoId: string,
  commands: PushCommand[],
): Promise<RefResult[]> {
  const results: RefResult[] = [];

  for (const command of commands) {
    // 條件式寫入取代「先讀後寫」：oldOid 直接寫進 where，
    // 比對由 SQLite 原子完成，免除 TOCTOU 競態，也省一次點查。
    if (command.newOid === ZERO_OID) {
      const removed = command.oldOid === ZERO_OID
        ? { count: 1 } // 冪等刪除：目標本來就不存在，視同成功（與舊行為一致）
        : await prisma.repoRef.deleteMany({
            where: { repoId, name: command.name, targetOid: command.oldOid },
          });
      if (removed.count === 0) {
        results.push({ name: command.name, ok: false, reason: 'stale info' });
        continue;
      }
      results.push({ name: command.name, ok: true });
      continue;
    }

    if (command.oldOid === ZERO_OID) {
      try {
        await prisma.repoRef.create({
          data: { repoId, name: command.name, targetOid: command.newOid },
        });
        results.push({ name: command.name, ok: true });
        continue;
      } catch (error) {
        // 並發推送已先建立同名的 ref：等同樂觀鎖不符。
        if ((error as { code?: string }).code === 'P2002') {
          results.push({ name: command.name, ok: false, reason: 'stale info' });
          continue;
        }
        throw error;
      }
    }

    const updated = await prisma.repoRef.updateMany({
      where: { repoId, name: command.name, targetOid: command.oldOid },
      data: { targetOid: command.newOid },
    });
    if (updated.count === 0) {
      results.push({ name: command.name, ok: false, reason: 'stale info' });
      continue;
    }
    results.push({ name: command.name, ok: true });
  }

  return results;
}
