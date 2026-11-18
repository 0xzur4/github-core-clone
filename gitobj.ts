// gitobj.ts — SHA-1 objects, packfile parse/build, delta application, pkt-line codec.
// Stdlib only (node:crypto, node:zlib). Implements the gitobj section of
// ~/workspace/makefun/gh-specs/store-api.md.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ObjectType } from './store.ts';

export function sha1Object(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function pktLine(s: string | Buffer): Buffer {
  const payload = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function parsePktLines(buf: Buffer): (Buffer | 'flush' | 'delim' | 'end')[] {
  const out: (Buffer | 'flush' | 'delim' | 'end')[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const len = parseInt(header, 16);
    if (len === 0) {
      out.push('flush');
      off += 4;
    } else if (len === 1) {
      out.push('delim');
      off += 4;
    } else if (len === 2) {
      out.push('end');
      off += 4;
    } else {
      if (len < 4 || len > 65520) throw new Error(`bad pkt-line length ${len}`);
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push(buf.subarray(off + 4, off + len));
      off += len;
    }
  }
  return out;
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let pos = off + 1;
  while (buf[pos - 1] & 0x80) {
    if (pos >= buf.length) throw new Error('truncated varint');
    value = ((value + 1) << 7) | (buf[pos] & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

function readSizeEncoding(buf: Buffer, off: number): { size: number; next: number } {
  let byte = buf[off];
  let size = byte & 0x0f;
  let shift = 4;
  let pos = off + 1;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('truncated size encoding');
    byte = buf[pos];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, next: pos };
}

const TYPE_BY_CODE: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const CODE_BY_TYPE: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/**
 * Inflate a zlib stream starting at `off`, whose inflated size is `expectedSize`.
 * Node's inflateSync ignores trailing bytes, so it cannot report the consumed
 * length; binary-search the smallest prefix that inflates to the expected size
 * (a shorter prefix is a truncated stream and throws, a longer one succeeds).
 *
 * Fast path: Node >= 22.5's `info: true` option returns the engine, whose
 * `bytesWritten` is exactly the compressed bytes the stream consumed — one
 * inflate per entry instead of ~log2(size) probes. Detected once at load so
 * an older Node silently falls back to the binary search below.
 */
const INFLATE_INFO_SUPPORTED: boolean = (() => {
  try {
    const probe = inflateSync(deflateSync(Buffer.from('x')), { info: true }) as unknown as {
      buffer?: unknown;
      engine?: { bytesWritten?: unknown };
    };
    return Buffer.isBuffer(probe.buffer) && typeof probe.engine?.bytesWritten === 'number';
  } catch {
    return false;
  }
})();

function inflateAt(buf: Buffer, off: number, expectedSize: number, limit: number): { data: Buffer; next: number } {
  if (off >= limit) throw new Error('pack entry extends past trailer');
  if (INFLATE_INFO_SUPPORTED) {
    try {
      const result = inflateSync(buf.subarray(off, limit), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (result.buffer.length === expectedSize) {
        // bytesWritten is the compressed bytes this stream consumed; a
        // stream that ran past the trailer is corrupt, not a valid entry.
        const next = off + result.engine.bytesWritten;
        if (next > limit) throw new Error('inflated pack entry has wrong size');
        return { data: result.buffer, next };
      }
      throw new Error('inflated pack entry has wrong size');
    } catch (err) {
      // A wrong-size result keeps the old error; a truncated/corrupt stream
      // falls through to the binary search, which throws the old error too.
      if (err instanceof Error && err.message === 'inflated pack entry has wrong size') throw err;
    }
  }
  let lo = off + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(off, mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('could not inflate pack entry');
  const data = inflateSync(buf.subarray(off, found));
  if (data.length !== expectedSize) throw new Error('inflated pack entry has wrong size');
  return { data, next: found };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (pos < delta.length) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      if (pos + op > delta.length) throw new Error('delta insert out of range');
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

export interface ParsedPackObject {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

export function parsePack(buf: Buffer): { objects: ParsedPackObject[] } {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  // Verify the trailer: SHA-1 of every preceding byte.
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const limit = buf.length - 20;
  const byOid = new Map<string, ParsedPackObject>();
  const byOffset = new Map<number, ParsedPackObject>();
  const pendingDeltas: { entryOffset: number; baseOid: string | null; baseOffset: number | null; delta: Buffer }[] = [];
  let off = 12;
  let parsed = 0;
  while (off < limit) {
    const entryOffset = off;
    const first = buf[off];
    const typeCode = (first >> 4) & 0x07;
    const sizeInfo = readSizeEncoding(buf, off);
    const size = sizeInfo.size;
    off = sizeInfo.next;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      const ofs = readVarint(buf, off);
      baseOffset = entryOffset - ofs.value;
      off = ofs.next;
    } else if (typeCode === 7) {
      if (off + 20 > limit) throw new Error('truncated REF_DELTA base');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!TYPE_BY_CODE[typeCode]) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateAt(buf, off, size, limit);
    off = inflated.next;
    parsed += 1;
    if (typeCode === 6 || typeCode === 7) {
      // For a delta entry the inflated payload IS the delta instructions.
      pendingDeltas.push({ entryOffset, baseOid, baseOffset, delta: inflated.data });
    } else {
      const type = TYPE_BY_CODE[typeCode];
      const oid = sha1Object(type, inflated.data);
      const obj: ParsedPackObject = { type, data: inflated.data, oid };
      byOid.set(oid, obj);
      byOffset.set(entryOffset, obj);
    }
  }
  if (parsed !== declaredCount) throw new Error(`pack declared ${declaredCount} objects but parsed ${parsed}`);
  if (off !== limit) throw new Error('pack has trailing bytes before trailer');
  // Resolve deltas (possibly chained); bases are in-pack for the suites' packs.
  const resolveDelta = (entry: { baseOid: string | null; baseOffset: number | null; delta: Buffer }): ParsedPackObject => {
    let base: ParsedPackObject | undefined;
    if (entry.baseOid) base = byOid.get(entry.baseOid);
    else if (entry.baseOffset !== null) base = byOffset.get(entry.baseOffset);
    if (!base) throw new Error('delta base not in pack');
    // The delta's result type is the base's type.
    const data = applyDelta(base.data, entry.delta);
    const oid = sha1Object(base.type, data);
    const obj: ParsedPackObject = { type: base.type, data, oid };
    byOid.set(oid, obj);
    byOffset.set(entry.entryOffset, obj);
    return obj;
  };
  // Resolve in pack order; a delta whose base is a later delta is handled by
  // retrying unresolved entries until progress stops.
  let remaining = [...pendingDeltas];
  while (remaining.length > 0) {
    let progressed = false;
    const next: typeof remaining = [];
    for (const entry of remaining) {
      const baseReady =
        (entry.baseOid !== null && byOid.has(entry.baseOid)) ||
        (entry.baseOffset !== null && byOffset.has(entry.baseOffset));
      if (baseReady) {
        resolveDelta(entry);
        progressed = true;
      } else {
        next.push(entry);
      }
    }
    if (!progressed) throw new Error('delta base not in pack');
    remaining = next;
  }
  return { objects: [...byOid.values()] };
}

export function buildPack(objects: { type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = CODE_BY_TYPE[obj.type];
    const size = obj.data.length;
    // Type/size varint: first byte (typeCode << 4) | (size & 0x0f), continuation bits.
    const headerBytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeCode << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
