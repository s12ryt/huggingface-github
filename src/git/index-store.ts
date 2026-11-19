/**
 * 索引雙存（E+1）：儲存桶 JSON 為權威副本，SQLite 僅為可重建快取。
 *
 * - packPath / indexPath：儲存桶 上的 pack 與索引檔位置
 * - writeIndex：上傳 pack 與索引，並同步寫入 SQLite 快取
 * - loadIndex：讀取權威索引副本
 * - lookupObject：由快取查出 (pack, offset, size) 三元組與展平 delta 鏈
 * - rebuildCacheFromStore：快取遺失時由權威副本幂等重建（byteSize 由索引推導，不下載 pack）
 */
import type { PrismaClient } from '@prisma/client';

import { assertIndexDocument, serializeIndex, type PackIndexDocument, type PackScan } from './pack.js';

/**
 * 寫入端只關心「有沒有成功」，不關心後端回傳什麼中介資料，
 * 因此回傳型別放寬為 unknown，讓真實 Store 與測試替身都能直接傳入。
 */
export interface IndexStoreIo {
  putBytes: (path: string, data: Buffer) => Promise<unknown>;
  putJson: (path: string, value: unknown) => Promise<unknown>;
  readAll: (path: string) => Promise<Buffer | null>;
  readJson: (path: string) => Promise<unknown>;
}

export interface WriteIndexArgs {
  pack: Buffer;
  packName: string;
  repoId: string;
  repoPath: string;
  scan: PackScan;
}

export interface RebuildArgs {
  packNames: string[];
  repoId: string;
  repoPath: string;
}

export interface ObjectLocation {
  deltaChain: string[];
  inflatedSize: number;
  objectType: string;
  packName: string;
  packOffset: number;
  storedSize: number;
}

export function packPath(repoPath: string, packName: string): string {
  return `${repoPath}/objects/${packName}`;
}

export function indexPath(repoPath: string, packName: string): string {
  return `${repoPath}/objects/${packName.replace(/\.pack$/, '')}.idx.json`;
}

async function cacheEntries(
  prisma: PrismaClient,
  repoId: string,
  packFileId: string,
  doc: PackIndexDocument,
): Promise<number> {
  await prisma.gitObjectIndex.deleteMany({ where: { packFileId } });
  if (doc.entries.length === 0) return 0;
  // 同一 repo 內一個 oid 只保留一筆索引：其他 pack 可能已收錄相同物件，
  // 先清掉舊歸屬再寫入，使重複寫入與重建皆為幂等。
  await prisma.gitObjectIndex.deleteMany({
    where: { oid: { in: doc.entries.map((entry) => entry.oid) }, repoId },
  });
  const result = await prisma.gitObjectIndex.createMany({
    data: doc.entries.map((entry) => ({
      deltaChain: entry.deltaChain.length > 0 ? JSON.stringify(entry.deltaChain) : null,
      inflatedSize: entry.inflatedSize,
      objectType: entry.objectType,
      oid: entry.oid,
      packFileId,
      packOffset: entry.packOffset,
      repoId,
      storedSize: entry.storedSize,
    })),
  });
  return result.count;
}

async function upsertPackFile(
  prisma: PrismaClient,
  repoId: string,
  packName: string,
  byteSize: number,
  objectCount: number,
): Promise<string> {
  const row = await prisma.packFile.upsert({
    create: { byteSize, name: packName, objectCount, repoId },
    select: { id: true },
    update: { byteSize, objectCount },
    where: { repoId_name: { name: packName, repoId } },
  });
  return row.id;
}

export async function writeIndex(
  prisma: PrismaClient,
  store: IndexStoreIo,
  args: WriteIndexArgs,
): Promise<void> {
  const doc = assertIndexDocument(
    JSON.parse(serializeIndex(args.packName, args.scan).toString('utf8')),
  );

  // pack（大檔，LFS 路徑）與索引 JSON 是兩個獨立檔案，並行上傳省一次序列等待。
  await Promise.all([
    store.putBytes(packPath(args.repoPath, args.packName), args.pack),
    store.putJson(indexPath(args.repoPath, args.packName), doc),
  ]);

  const packFileId = await upsertPackFile(
    prisma,
    args.repoId,
    args.packName,
    args.pack.length,
    args.scan.objectCount,
  );
  await cacheEntries(prisma, args.repoId, packFileId, doc);
}

export async function loadIndex(
  store: IndexStoreIo,
  repoPath: string,
  packName: string,
): Promise<PackIndexDocument | null> {
  const raw = await store.readJson(indexPath(repoPath, packName));
  if (raw === null || raw === undefined) return null;
  try {
    return assertIndexDocument(raw);
  } catch {
    return null;
  }
}

export async function lookupObject(
  prisma: PrismaClient,
  repoId: string,
  oid: string,
): Promise<ObjectLocation | null> {
  const row = await prisma.gitObjectIndex.findUnique({
    include: { packFile: { select: { name: true } } },
    where: { repoId_oid: { oid, repoId } },
  });
  if (!row) return null;
  return toLocation(row);
}

/** 批量版：一次 IN 查詢取代 N 次 findUnique，查不到的 oid 不會出現在結果映射。 */
export async function lookupObjects(
  prisma: PrismaClient,
  repoId: string,
  oids: readonly string[],
): Promise<Map<string, ObjectLocation>> {
  if (oids.length === 0) return new Map();
  const rows = await prisma.gitObjectIndex.findMany({
    include: { packFile: { select: { name: true } } },
    where: { oid: { in: [...oids] }, repoId },
  });
  const out = new Map<string, ObjectLocation>();
  for (const row of rows) out.set(row.oid, toLocation(row));
  return out;
}

interface LocationRow {
  deltaChain: string | null;
  inflatedSize: number;
  objectType: string;
  packFile: { name: string };
  packOffset: number;
  oid: string;
  storedSize: number;
}

function toLocation(row: LocationRow): ObjectLocation {
  return {
    deltaChain: row.deltaChain ? (JSON.parse(row.deltaChain) as string[]) : [],
    inflatedSize: row.inflatedSize,
    objectType: row.objectType,
    packName: row.packFile.name,
    packOffset: row.packOffset,
    storedSize: row.storedSize,
  };
}

/** pack 總長由索引推導：最後一筆結尾 + 20B sha1 trailer（空 pack = 12B 檔頭 + 20B = 32）。 */
function packSizeFromDoc(doc: PackIndexDocument): number {
  return doc.entries.reduce((max, entry) => Math.max(max, entry.packOffset + entry.storedSize), 0) + 20;
}

export async function rebuildCacheFromStore(
  prisma: PrismaClient,
  store: IndexStoreIo,
  args: RebuildArgs,
): Promise<number> {
  let restored = 0;
  for (const packName of args.packNames) {
    const doc = await loadIndex(store, args.repoPath, packName);
    if (!doc) continue;
    // byteSize 直接由索引推導，不下載（也不重新解密）pack 本體；
    // 索引文件損壞時 loadIndex 早已回 null，走到這裡的 doc 都通過結構驗證。
    const packFileId = await upsertPackFile(
      prisma,
      args.repoId,
      packName,
      packSizeFromDoc(doc),
      doc.objectCount,
    );
    restored += await cacheEntries(prisma, args.repoId, packFileId, doc);
  }
  return restored;
}
