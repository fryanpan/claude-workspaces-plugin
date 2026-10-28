/**
 * The part of CBOR (RFC 8949) a passkey's registration uses: unsigned and
 * negative integers, byte and text strings, arrays, maps, and the simple
 * values false, true and null.
 *
 * It refuses everything else: indefinite lengths, tags, floats, 64-bit
 * lengths, nesting past a fixed depth, and a length that runs past the end
 * of the input. A refusal throws, and the caller refuses the passkey.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

const MAX_DEPTH = 8;

/** Decode one item at `offset`; `end` is where the item stopped. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = offset;

  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('cbor: input ends inside an item');
  };

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++] as number;
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    throw new Error('cbor: unsupported length encoding');
  };

  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new Error('cbor: nested too deep');
    need(1);
    const head = bytes[pos++] as number;
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        need(n);
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = readLength(info);
        need(n);
        const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = readLength(info);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = readLength(info);
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (out.has(k)) throw new Error('cbor: duplicate map key');
          out.set(k, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor: unsupported simple value');
      default:
        throw new Error(`cbor: unsupported major type ${major}`);
    }
  };

  const value = item(0);
  return { value, end: pos };
}
