/**
 * 物件讀取器：由 SQLite 索引三元組 + 儲存桶 Range 還原 Git 物件（E+2 / E+4）。
 *
 * - createObjectReader：建立讀取器（has / read / readMany）
 * - 展平的 delta 鏈讓整條鏈的位移在單一批次請求中取回，不遞迴查表
 */
import type { PrismaClient } from '@prisma/client';

import { applyDelta } from './delta.js';
import {
  lookupObject,
  lookupObjects,
  packPath,
  type ObjectLocation,
} from './index-store.js';
import { isGitObjectType, type GitObjectType } from './object.js';
import { decodeRecordSlice } from './pack.js';

export interface ReaderIo {
  readRanges: (
    path: string,
    ranges: readonly { start: number; end: number }[],
  ) => Promise<Buffer[]>;
}

export interface ReaderOptions {
  repoId: string;
  repoPath: string;
}

export interface GitObjectPayload {
  content: Buffer;
  oid: string;
  type: GitObjectType;
}

export interface ObjectReader {
  has(oid: string): Promise<boolean>;
  read(oid: string): Promise<GitObjectPayload | null>;
  readMany(oids: readonly string[]): Promise<GitObjectPayload[]>;
}

export class ObjectReadError extends Error {
  constructor(reason: string) {
    super(`Cannot read git object: ${reason}`);
    this.name = 'ObjectReadError';
  }
}

interface Plan {
  chain: ObjectLocation[];
  location: ObjectLocation;
  oid: string;
}

function rangeOf(location: ObjectLocation): { end: number; start: number } {
  return { end: location.packOffset + location.storedSize - 1, start: location.packOffset };
}

function keyOf(packName: string, start: number): string {
  return `${packName}#${start}`;
}

export function createObjectReader(
  prisma: PrismaClient,
  io: ReaderIo,
  options: ReaderOptions,
): ObjectReader {
  const locate = (oid: string) => lookupObject(prisma, options.repoId, oid);

  /**
   * 批量解析：目標 oid 與其 delta 鏈上的 base 以 IN 查詢分層補齊，
   * 每層一次查詢。1000 個物件的 clone 從 1000+ 次點查降到 1~2 次批量查詢。
   */
  const resolveLocations = async (
    oids: readonly string[],
  ): Promise<Map<string, ObjectLocation | null>> => {
    const resolved = new Map<string, ObjectLocation | null>();
    let pending = [...new Set(oids)];
    while (pending.length > 0) {
      const found = await lookupObjects(prisma, options.repoId, pending);
      const next: string[] = [];
      for (const oid of pending) {
        const location = found.get(oid) ?? null;
        resolved.set(oid, location);
        if (location) {
          for (const baseOid of location.deltaChain) {
            if (!resolved.has(baseOid)) next.push(baseOid);
          }
        }
      }
      pending = [...new Set(next)];
    }
    return resolved;
  };

  // 展平的 delta 鏈由近到遠，逐一查出位置即可一次算出全部待取區間。
  const planFor = async (oid: string): Promise<Plan | null> => {
    const location = await locate(oid);
    if (location === null) return null;

    const chain: ObjectLocation[] = [];
    for (const baseOid of location.deltaChain) {
      const base = await locate(baseOid);
      if (base === null) throw new ObjectReadError(`delta base ${baseOid} is not indexed`);
      chain.push(base);
    }
    return { chain, location, oid };
  };

  const fetchSlices = async (plans: readonly Plan[]): Promise<Map<string, Buffer>> => {
    const byPack = new Map<string, Map<number, { end: number; start: number }>>();

    for (const plan of plans) {
      for (const location of [plan.location, ...plan.chain]) {
        const perPack = byPack.get(location.packName) ?? new Map();
        perPack.set(location.packOffset, rangeOf(location));
        byPack.set(location.packName, perPack);
      }
    }

    // 各 pack 是不同檔案，彼此獨立；並行抓取以省下逐包等待的往返時間。
    const slices = new Map<string, Buffer>();
    await Promise.all(
      [...byPack].map(async ([packName, perPack]) => {
        const ranges = [...perPack.values()];
        const payloads = await io.readRanges(packPath(options.repoPath, packName), ranges);
        ranges.forEach((range, index) => {
          const payload = payloads[index];
          if (payload === undefined) throw new ObjectReadError(`missing slice for ${packName}`);
          slices.set(keyOf(packName, range.start), payload);
        });
      }),
    );
    return slices;
  };

  const materialize = (plan: Plan, slices: Map<string, Buffer>): GitObjectPayload => {
    const take = (location: ObjectLocation): Buffer => {
      const slice = slices.get(keyOf(location.packName, location.packOffset));
      if (slice === undefined) throw new ObjectReadError(`slice for ${plan.oid} was not fetched`);
      return decodeRecordSlice(slice).payload;
    };

    // 由最遠的 base 往回套用 delta，最後得到目標物件內容。
    let content = plan.chain.length === 0 ? take(plan.location) : take(plan.chain.at(-1)!);
    for (let i = plan.chain.length - 2; i >= 0; i -= 1) {
      content = applyDelta(content, take(plan.chain[i]!));
    }
    if (plan.chain.length > 0) content = applyDelta(content, take(plan.location));

    const type = plan.location.objectType;
    if (!isGitObjectType(type)) throw new ObjectReadError(`unknown object type for ${plan.oid}`);
    return { content, oid: plan.oid, type };
  };

  return {
    has: async (oid) => (await locate(oid)) !== null,

    read: async (oid) => {
      const plan = await planFor(oid);
      if (plan === null) return null;
      return materialize(plan, await fetchSlices([plan]));
    },

    readMany: async (oids) => {
      if (oids.length === 0) return [];
      const locations = await resolveLocations(oids);
      const plans: Plan[] = [];
      // 缺失檢查依輸入順序進行，錯誤對象維持確定性。
      oids.forEach((oid) => {
        const location = locations.get(oid) ?? null;
        if (location === null) throw new ObjectReadError(`object ${oid} is not indexed`);
        const chain: ObjectLocation[] = [];
        for (const baseOid of location.deltaChain) {
          const base = locations.get(baseOid) ?? null;
          if (base === null) throw new ObjectReadError(`delta base ${baseOid} is not indexed`);
          chain.push(base);
        }
        plans.push({ chain, location, oid });
      });
      const slices = await fetchSlices(plans);
      return plans.map((plan) => materialize(plan, slices));
    },
  };
}
