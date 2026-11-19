/**
 * Git pkt-line 編解碼（Smart HTTP 傳輸的封包格式）。
 *
 * - FLUSH_PKT / DELIM_PKT：控制封包常數
 * - encodePkt / encodeText：資料封包編碼
 * - parsePktLines：串流解析為封包序列
 * - sideBand：side-band-64k 頻道封裝
 */

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const MAX_PKT_PAYLOAD = 65516;
export const SIDE_BAND_CHANNELS = [1, 2, 3] as const;

export type PktKind = 'data' | 'delim' | 'flush';

export interface PktLine {
  kind: PktKind;
  payload?: Buffer;
}

export class PktLineError extends Error {
  constructor(reason: string) {
    super(`Invalid pkt-line: ${reason}`);
    this.name = 'PktLineError';
  }
}

export function encodePkt(payload: Buffer): Buffer {
  if (payload.length > MAX_PKT_PAYLOAD) throw new PktLineError('payload exceeds maximum');
  const length = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(length, 'ascii'), payload]);
}

export function encodeText(text: string): Buffer {
  return encodePkt(Buffer.from(text, 'utf8'));
}

export function sideBand(channel: number, payload: Buffer): Buffer {
  if (!(SIDE_BAND_CHANNELS as readonly number[]).includes(channel)) {
    throw new PktLineError('unknown side-band channel');
  }
  if (payload.length + 1 > MAX_PKT_PAYLOAD) throw new PktLineError('payload exceeds maximum');
  // 單次配置輸出：長度前綴 + 頻道位元組 + 內容。clone 回應每 64KiB 一片，
  // 走 concat 得複製兩次；這裡只寫入一次。
  const out = Buffer.alloc(5 + payload.length);
  out.write((5 + payload.length).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  out[4] = channel;
  payload.copy(out, 5);
  return out;
}

export function parsePktLines(stream: Buffer): PktLine[] {
  const packets: PktLine[] = [];
  let cursor = 0;

  while (cursor < stream.length) {
    if (cursor + 4 > stream.length) throw new PktLineError('truncated length header');
    const header = stream.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new PktLineError('length header is not hex');
    const length = Number.parseInt(header, 16);
    cursor += 4;

    if (length === 0) {
      packets.push({ kind: 'flush' });
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (length < 4) throw new PktLineError('reserved length value');
    const end = cursor + (length - 4);
    if (end > stream.length) throw new PktLineError('declared length exceeds stream');
    packets.push({ kind: 'data', payload: stream.subarray(cursor, end) });
    cursor = end;
  }

  return packets;
}

export function findPackBoundary(stream: Buffer): number {
  let cursor = 0;
  while (cursor < stream.length) {
    if (cursor + 4 > stream.length) throw new PktLineError('truncated length header');
    const header = stream.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new PktLineError('length header is not hex');
    const length = Number.parseInt(header, 16);
    if (length === 0) return cursor + 4;
    cursor += length <= 1 ? 4 : length;
  }
  return stream.length;
}
