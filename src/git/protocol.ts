/**
 * Smart HTTP 協議組裝。
 *
 * - serviceAdvertisement / advertiseRefs：info/refs 廣告（含能力與 symref）
 * - parseUploadRequest / uploadResponse：upload-pack 的 want/have 與 pack 回應
 * - parsePushCommands / reportStatus：receive-pack 的指令解析與結果回報
 */
import {
  FLUSH_PKT,
  encodePkt,
  encodeText,
  findPackBoundary,
  parsePktLines,
  sideBand,
} from './pktline.js';

export const ZERO_OID = '0'.repeat(40);
export const AGENT = 'onedrive-github/0.1.0';
export const UPLOAD_CAPABILITIES = [
  'multi_ack_detailed',
  'side-band-64k',
  'ofs-delta',
  'thin-pack',
  'no-progress',
];
export const RECEIVE_CAPABILITIES = ['report-status', 'delete-refs', 'ofs-delta'];

const OID_PATTERN = /^[0-9a-f]{40}$/;

export interface RefAdvertisement {
  name: string;
  oid: string;
}

export interface UploadRequest {
  capabilities: string[];
  deepen: number | null;
  done: boolean;
  haves: string[];
  wants: string[];
}

export interface PushCommand {
  name: string;
  newOid: string;
  oldOid: string;
}

export interface PushRequest {
  capabilities: string[];
  commands: PushCommand[];
  packData: Buffer;
}

export interface RefResult {
  name: string;
  ok: boolean;
  reason?: string;
}

function normalizeOid(value: string | undefined): string | null {
  const lowered = value?.toLowerCase() ?? '';
  return OID_PATTERN.test(lowered) ? lowered : null;
}

export function serviceAdvertisement(service: string): Buffer {
  return Buffer.concat([encodeText(`# service=${service}\n`), FLUSH_PKT]);
}

export function advertiseRefs(
  refs: RefAdvertisement[],
  defaultBranch: string,
  capabilities: string[] = UPLOAD_CAPABILITIES,
): Buffer {
  const caps = [...capabilities, `symref=HEAD:refs/heads/${defaultBranch}`, `agent=${AGENT}`];
  const sorted = [...refs].sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    return Buffer.concat([
      encodeText(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`),
      FLUSH_PKT,
    ]);
  }

  const lines = sorted.map((ref, index) =>
    index === 0
      ? encodeText(`${ref.oid} ${ref.name}\0${caps.join(' ')}\n`)
      : encodeText(`${ref.oid} ${ref.name}\n`),
  );
  return Buffer.concat([...lines, FLUSH_PKT]);
}

export function parseUploadRequest(body: Buffer): UploadRequest {
  const request: UploadRequest = {
    capabilities: [],
    deepen: null,
    done: false,
    haves: [],
    wants: [],
  };

  for (const packet of parsePktLines(body)) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').trimEnd();
    const [verb, ...rest] = line.split(' ');

    if (verb === 'want') {
      const oid = normalizeOid(rest[0]);
      if (oid) request.wants.push(oid);
      if (request.capabilities.length === 0 && rest.length > 1) {
        request.capabilities = rest.slice(1);
      }
      continue;
    }
    if (verb === 'have') {
      const oid = normalizeOid(rest[0]);
      if (oid) request.haves.push(oid);
      continue;
    }
    if (verb === 'deepen') {
      const depth = Number(rest[0]);
      if (Number.isInteger(depth)) request.deepen = depth;
      continue;
    }
    if (verb === 'done') request.done = true;
  }

  return request;
}

export function uploadResponse(pack: Buffer, acks: string[], useSideBand: boolean): Buffer {
  const head =
    acks.length === 0
      ? [encodeText('NAK\n')]
      : acks.map((oid) => encodeText(`ACK ${oid}\n`));

  if (!useSideBand) return Buffer.concat([...head, pack]);

  const chunks: Buffer[] = [...head];
  const limit = 65515;
  for (let offset = 0; offset < pack.length; offset += limit) {
    chunks.push(sideBand(1, pack.subarray(offset, offset + limit)));
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

export function parsePushCommands(body: Buffer): PushRequest {
  const boundary = findPackBoundary(body);
  const request: PushRequest = {
    capabilities: [],
    commands: [],
    packData: body.subarray(boundary),
  };

  for (const packet of parsePktLines(body.subarray(0, boundary))) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).trimEnd();
    if (nul >= 0 && request.capabilities.length === 0) {
      request.capabilities = raw.slice(nul + 1).trimEnd().split(' ').filter(Boolean);
    }

    const [oldRaw, newRaw, name] = line.split(' ');
    const oldOid = normalizeOid(oldRaw);
    const newOid = normalizeOid(newRaw);
    if (!oldOid || !newOid || !name?.startsWith('refs/')) continue;
    request.commands.push({ name, newOid, oldOid });
  }

  return request;
}

export function reportStatus(results: RefResult[], unpackError?: string): Buffer {
  const lines = [encodeText(`unpack ${unpackError ?? 'ok'}\n`)];
  for (const result of results) {
    lines.push(
      result.ok
        ? encodeText(`ok ${result.name}\n`)
        : encodeText(`ng ${result.name} ${result.reason ?? 'rejected'}\n`),
    );
  }
  lines.push(FLUSH_PKT);
  return Buffer.concat(lines);
}

export function errorPacket(message: string): Buffer {
  return Buffer.concat([encodePkt(Buffer.from(`ERR ${message}\n`, 'utf8')), FLUSH_PKT]);
}
