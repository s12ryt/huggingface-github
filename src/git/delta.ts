/**
 * Git delta 解碼（packfile 的 ofs_delta / ref_delta 內容格式）。
 *
 * - readDeltaSizes：讀出 base 與 result 的可變長度大小
 * - applyDelta：執行 copy / insert 指令還原完整內容
 */

export class DeltaError extends Error {
  constructor(reason: string) {
    super(`Invalid delta: ${reason}`);
    this.name = 'DeltaError';
  }
}

export interface DeltaSizes {
  baseSize: number;
  offset: number;
  resultSize: number;
}

function readVarSize(delta: Buffer, start: number): { offset: number; value: number } {
  let value = 0;
  let shift = 1;
  let offset = start;
  for (;;) {
    const byte = delta[offset];
    if (byte === undefined) throw new DeltaError('truncated size header');
    offset += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { offset, value };
    shift *= 128;
  }
}

export function readDeltaSizes(delta: Buffer): DeltaSizes {
  const base = readVarSize(delta, 0);
  const result = readVarSize(delta, base.offset);
  return { baseSize: base.value, offset: result.offset, resultSize: result.value };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sizes = readDeltaSizes(delta);
  if (base.length !== sizes.baseSize) throw new DeltaError('base size mismatch');

  const out = Buffer.alloc(sizes.resultSize);
  let written = 0;
  let cursor = sizes.offset;

  while (cursor < delta.length) {
    const op = delta[cursor];
    if (op === undefined) break;
    cursor += 1;

    if (op === 0x00) throw new DeltaError('reserved opcode 0x00');

    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          const byte = delta[cursor];
          if (byte === undefined) throw new DeltaError('truncated copy offset');
          cursor += 1;
          copyOffset |= byte << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (1 << (4 + i))) !== 0) {
          const byte = delta[cursor];
          if (byte === undefined) throw new DeltaError('truncated copy size');
          cursor += 1;
          copySize |= byte << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new DeltaError('copy exceeds base');
      if (written + copySize > out.length) throw new DeltaError('copy exceeds result size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
      continue;
    }

    if (cursor + op > delta.length) throw new DeltaError('insert exceeds delta buffer');
    if (written + op > out.length) throw new DeltaError('insert exceeds result size');
    delta.copy(out, written, cursor, cursor + op);
    cursor += op;
    written += op;
  }

  if (written !== sizes.resultSize) throw new DeltaError('result size mismatch');
  return out;
}
