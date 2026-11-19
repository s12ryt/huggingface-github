/**
 * Smart HTTP 協議組裝測試：info/refs 廣告、want/have 解析、receive-pack 指令與回報。
 */
import { describe, expect, it } from 'vitest';

import {
  ZERO_OID,
  advertiseRefs,
  parsePushCommands,
  parseUploadRequest,
  serviceAdvertisement,
  uploadResponse,
  reportStatus,
} from '@/git/protocol.js';
import { FLUSH_PKT, encodeText, parsePktLines } from '@/git/pktline.js';

const oid1 = '1'.repeat(40);
const oid2 = '2'.repeat(40);

describe('服務廣告標頭', () => {
  it('第一個封包為 # service=<name>', () => {
    const packets = parsePktLines(serviceAdvertisement('git-upload-pack'));
    expect(packets[0]?.payload?.toString('utf8')).toBe('# service=git-upload-pack\n');
  });

  it('標頭後接 flush', () => {
    const packets = parsePktLines(serviceAdvertisement('git-upload-pack'));
    expect(packets[1]?.kind).toBe('flush');
  });
});

describe('ref 廣告', () => {
  it('首行附帶能力清單且以 NUL 分隔', () => {
    const text = advertiseRefs([{ name: 'refs/heads/main', oid: oid1 }], 'main').toString('utf8');
    const first = parsePktLines(advertiseRefs([{ name: 'refs/heads/main', oid: oid1 }], 'main'))[0];
    const payload = first?.payload?.toString('utf8') ?? '';
    expect(payload.startsWith(`${oid1} refs/heads/main\0`)).toBe(true);
    expect(text).toContain('side-band-64k');
  });

  it('宣告 agent 能力', () => {
    expect(advertiseRefs([{ name: 'refs/heads/main', oid: oid1 }], 'main').toString('utf8')).toContain(
      'agent=',
    );
  });

  it('後續 ref 不重複附帶能力清單', () => {
    const packets = parsePktLines(
      advertiseRefs(
        [
          { name: 'refs/heads/main', oid: oid1 },
          { name: 'refs/heads/dev', oid: oid2 },
        ],
        'main',
      ),
    );
    // 排序後 dev 在 main 之前，故第二個封包為 main 且不再附帶能力清單
    expect(packets[1]?.payload?.toString('utf8')).toBe(`${oid1} refs/heads/main\n`);
  });

  it('ref 依名稱排序以符合 git 期望', () => {
    const packets = parsePktLines(
      advertiseRefs(
        [
          { name: 'refs/heads/zeta', oid: oid1 },
          { name: 'refs/heads/alpha', oid: oid2 },
        ],
        'main',
      ),
    );
    expect(packets[0]?.payload?.toString('utf8').includes('refs/heads/alpha')).toBe(true);
  });

  it('宣告 HEAD 的符號參照', () => {
    expect(advertiseRefs([{ name: 'refs/heads/main', oid: oid1 }], 'main').toString('utf8')).toContain(
      'symref=HEAD:refs/heads/main',
    );
  });

  it('空 repo 廣告 capabilities^{} 與零 oid', () => {
    const packets = parsePktLines(advertiseRefs([], 'main'));
    const payload = packets[0]?.payload?.toString('utf8') ?? '';
    expect(payload.startsWith(`${ZERO_OID} capabilities^{}\0`)).toBe(true);
  });

  it('廣告以 flush 結尾', () => {
    const packets = parsePktLines(advertiseRefs([{ name: 'refs/heads/main', oid: oid1 }], 'main'));
    expect(packets.at(-1)?.kind).toBe('flush');
  });
});

describe('upload-pack 請求解析', () => {
  function request(lines: string[]) {
    return Buffer.concat([...lines.map((line) => encodeText(line)), FLUSH_PKT, encodeText('done\n')]);
  }

  it('解析出 want 清單', () => {
    const parsed = parseUploadRequest(request([`want ${oid1}\n`, `want ${oid2}\n`]));
    expect(parsed.wants).toEqual([oid1, oid2]);
  });

  it('解析首個 want 行附帶的能力', () => {
    const parsed = parseUploadRequest(request([`want ${oid1} side-band-64k ofs-delta\n`]));
    expect(parsed.capabilities).toContain('side-band-64k');
    expect(parsed.wants).toEqual([oid1]);
  });

  it('解析 have 清單', () => {
    const parsed = parseUploadRequest(request([`want ${oid1}\n`, `have ${oid2}\n`]));
    expect(parsed.haves).toEqual([oid2]);
  });

  it('辨識 done', () => {
    expect(parseUploadRequest(request([`want ${oid1}\n`])).done).toBe(true);
  });

  it('沒有 done 時回報 false', () => {
    expect(parseUploadRequest(encodeText(`want ${oid1}\n`)).done).toBe(false);
  });

  it('解析 deepen 深度', () => {
    const parsed = parseUploadRequest(request([`want ${oid1}\n`, 'deepen 1\n']));
    expect(parsed.deepen).toBe(1);
  });

  it('忽略無法辨識的行而不拋錯', () => {
    const parsed = parseUploadRequest(request([`want ${oid1}\n`, 'unknown-verb foo\n']));
    expect(parsed.wants).toEqual([oid1]);
  });

  it('大小寫不一致的 oid 正規化為小寫', () => {
    const parsed = parseUploadRequest(request([`want ${'A'.repeat(40)}\n`]));
    expect(parsed.wants).toEqual(['a'.repeat(40)]);
  });

  it('非法 oid 長度被忽略', () => {
    expect(parseUploadRequest(request(['want abc\n'])).wants).toEqual([]);
  });
});

describe('upload-pack 回應', () => {
  it('無 have 時回 NAK', () => {
    expect(uploadResponse(Buffer.from('PACKDATA'), [], false).toString('utf8')).toContain('NAK');
  });

  it('有共同基礎時回 ACK', () => {
    const body = uploadResponse(Buffer.from('PACKDATA'), [oid1], false).toString('utf8');
    expect(body).toContain(`ACK ${oid1}`);
  });

  it('未啟用 side-band 時直接附上 pack 位元組', () => {
    const body = uploadResponse(Buffer.from('PACKDATA'), [], false);
    expect(body.subarray(body.length - 8).toString('utf8')).toBe('PACKDATA');
  });

  it('啟用 side-band 時 pack 包在頻道 1', () => {
    const packets = parsePktLines(uploadResponse(Buffer.from('PACKDATA'), [], true));
    const dataPacket = packets.find((p) => p.payload?.[0] === 1);
    expect(dataPacket?.payload?.subarray(1).toString('utf8')).toBe('PACKDATA');
  });

  it('side-band 回應以 flush 結尾', () => {
    const packets = parsePktLines(uploadResponse(Buffer.from('PACKDATA'), [], true));
    expect(packets.at(-1)?.kind).toBe('flush');
  });
});

describe('receive-pack 指令解析', () => {
  function push(lines: string[], packData = Buffer.alloc(0)) {
    return Buffer.concat([...lines.map((line) => encodeText(line)), FLUSH_PKT, packData]);
  }

  it('解析建立新 ref 的指令', () => {
    const parsed = parsePushCommands(push([`${ZERO_OID} ${oid1} refs/heads/main\0report-status\n`]));
    expect(parsed.commands[0]).toEqual({
      name: 'refs/heads/main',
      newOid: oid1,
      oldOid: ZERO_OID,
    });
  });

  it('解析能力清單', () => {
    const parsed = parsePushCommands(push([`${ZERO_OID} ${oid1} refs/heads/main\0report-status\n`]));
    expect(parsed.capabilities).toContain('report-status');
  });

  it('解析刪除 ref 的指令（新 oid 為零）', () => {
    const parsed = parsePushCommands(push([`${oid1} ${ZERO_OID} refs/heads/old\n`]));
    expect(parsed.commands[0]?.newOid).toBe(ZERO_OID);
  });

  it('解析多筆指令', () => {
    const parsed = parsePushCommands(
      push([`${ZERO_OID} ${oid1} refs/heads/a\n`, `${ZERO_OID} ${oid2} refs/heads/b\n`]),
    );
    expect(parsed.commands).toHaveLength(2);
  });

  it('flush 之後的位元組視為 packfile', () => {
    const parsed = parsePushCommands(
      push([`${ZERO_OID} ${oid1} refs/heads/main\n`], Buffer.from('PACK-bytes')),
    );
    expect(parsed.packData.toString('utf8')).toBe('PACK-bytes');
  });

  it('沒有 packfile 時 packData 為空', () => {
    const parsed = parsePushCommands(push([`${oid1} ${ZERO_OID} refs/heads/old\n`]));
    expect(parsed.packData.length).toBe(0);
  });

  it('格式錯誤的指令行被忽略', () => {
    expect(parsePushCommands(push(['garbage line\n'])).commands).toEqual([]);
  });
});

describe('report-status', () => {
  it('全部成功時回 unpack ok 與逐 ref ok', () => {
    const text = reportStatus([{ name: 'refs/heads/main', ok: true }]).toString('utf8');
    expect(text).toContain('unpack ok');
    expect(text).toContain('ok refs/heads/main');
  });

  it('失敗的 ref 回 ng 與原因', () => {
    const text = reportStatus([
      { name: 'refs/heads/main', ok: false, reason: 'non-fast-forward' },
    ]).toString('utf8');
    expect(text).toContain('ng refs/heads/main non-fast-forward');
  });

  it('解包失敗時回 unpack 錯誤原因', () => {
    const text = reportStatus([], 'invalid pack').toString('utf8');
    expect(text).toContain('unpack invalid pack');
  });

  it('回報以 flush 結尾', () => {
    const packets = parsePktLines(reportStatus([{ name: 'refs/heads/main', ok: true }]));
    expect(packets.at(-1)?.kind).toBe('flush');
  });

  it('零 oid 常數為 40 個 0', () => {
    expect(ZERO_OID).toBe('0'.repeat(40));
  });
});
