/**
 * 以 git 樹物件計算變更檔案清單
 *
 * 1. DiffEntry：單一檔案的變更紀錄（含新舊 oid 供後續取內容）
 * 2. diffTrees：遞迴比對兩棵樹，輸出依路徑排序的 diff
 */
import { parseTree } from '../git/parse.js';
import type { ObjectReader } from '../git/reader.js';

export type DiffStatus = 'added' | 'modified' | 'removed';

export interface DiffEntry {
  newOid: string | null;
  oldOid: string | null;
  path: string;
  status: DiffStatus;
}

const TREE_MODE = '40000';

/** 把一棵樹展平成 `path -> oid`，讓比對退化成單純的 map 差集。 */
async function flatten(
  reader: ObjectReader,
  treeOid: string,
  prefix: string,
  into: Map<string, string>,
): Promise<void> {
  const object = await reader.read(treeOid);
  if (!object || object.type !== 'tree') return;

  // 同層子樹彼此獨立（寫入的鍵互不重疊），並行展開以省下序列等待；
  // 最終 diff 由 diffTrees 依路徑排序，結果與序列版逐位元組相同。
  await Promise.all(
    parseTree(object.content).map(async (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === TREE_MODE) {
        await flatten(reader, entry.oid, path, into);
      } else {
        into.set(path, entry.oid);
      }
    }),
  );
}

export async function diffTrees(
  reader: ObjectReader,
  baseTree: string,
  headTree: string,
): Promise<DiffEntry[]> {
  if (baseTree === headTree) return [];

  const base = new Map<string, string>();
  const head = new Map<string, string>();
  // base 與 head 兩棵樹互不依賴，並行展平。
  await Promise.all([flatten(reader, baseTree, '', base), flatten(reader, headTree, '', head)]);

  const entries: DiffEntry[] = [];
  for (const [path, newOid] of head) {
    const oldOid = base.get(path);
    if (!oldOid) entries.push({ newOid, oldOid: null, path, status: 'added' });
    else if (oldOid !== newOid) entries.push({ newOid, oldOid, path, status: 'modified' });
  }
  for (const [path, oldOid] of base) {
    if (!head.has(path)) entries.push({ newOid: null, oldOid, path, status: 'removed' });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
