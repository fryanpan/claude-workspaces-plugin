/**
 * The lead's CONNECT proxy, pure half: reading a CONNECT request and the
 * server name a TLS ClientHello carries. `lead-proxy.ts` runs them.
 * Tested in `packages/server/test/project-machine-lead-proxy.test.ts`.
 */

export type Connect =
  | { ok: true; host: string; port: number }
  | { ok: false; status: 400 | 405; reason: string };

/** The request head, up to and without the blank line. Only `CONNECT host:port` is served. */
export function parseConnect(head: string): Connect {
  const [line = ''] = head.split('\r\n');
  const m = /^(\S+) (\S+) HTTP\/1\.[01]$/.exec(line);
  if (!m) return { ok: false, status: 400, reason: 'not an HTTP request line' };
  const [, method = '', target = ''] = m;
  if (method !== 'CONNECT') {
    return {
      ok: false,
      status: 405,
      reason: `${method} is not served; only CONNECT (HTTPS_PROXY)`,
    };
  }
  const t = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target);
  const port = Number(t?.[2]);
  if (!t || port < 1 || port > 65535) {
    return { ok: false, status: 400, reason: `${JSON.stringify(target)} is not host:port` };
  }
  return { ok: true, host: (t[1] as string).toLowerCase().replace(/\.$/, ''), port };
}

export type Hello =
  | { kind: 'incomplete' }
  | { kind: 'not-tls' }
  | { kind: 'sni'; name: string }
  | { kind: 'no-sni' }
  | { kind: 'bad' };

/** The largest first record read before giving up: a TLS record's limit plus its header. */
export const MAX_HELLO = 16384 + 5;

/**
 * The server name in the first TLS record, if the bytes are a ClientHello.
 * `incomplete` asks for more bytes; anything malformed is `bad`.
 */
export function readHello(buf: Uint8Array): Hello {
  if (buf.length === 0) return { kind: 'incomplete' };
  if (buf[0] !== 0x16) return { kind: 'not-tls' };
  if (buf.length < 5) return { kind: 'incomplete' };
  const recLen = ((buf[3] ?? 0) << 8) | (buf[4] ?? 0);
  if (recLen + 5 > MAX_HELLO) return { kind: 'bad' };
  if (buf.length < recLen + 5) return { kind: 'incomplete' };
  const rec = buf.subarray(5, 5 + recLen);
  let p = 0;
  const u8 = () => {
    if (p + 1 > rec.length) throw new Error('short');
    return rec[p++] as number;
  };
  const u16 = () => (u8() << 8) | u8();
  const skip = (n: number) => {
    if (p + n > rec.length) throw new Error('short');
    p += n;
  };
  try {
    if (u8() !== 0x01) return { kind: 'bad' }; // ClientHello
    const hsLen = (u8() << 16) | u16();
    // A ClientHello split across records is not served.
    if (hsLen + 4 > rec.length) return { kind: 'bad' };
    skip(2 + 32); // version, random
    skip(u8()); // session id
    skip(u16()); // cipher suites
    skip(u8()); // compression methods
    if (p === rec.length) return { kind: 'no-sni' };
    const extEnd = p + 2 + u16();
    if (extEnd > rec.length) return { kind: 'bad' };
    while (p < extEnd) {
      const type = u16();
      const len = u16();
      if (type !== 0) {
        skip(len);
        continue;
      }
      const listEnd = p + 2 + u16();
      while (p < listEnd) {
        const nameType = u8();
        const nameLen = u16();
        if (p + nameLen > rec.length) return { kind: 'bad' };
        const name = new TextDecoder().decode(rec.subarray(p, p + nameLen));
        p += nameLen;
        if (nameType === 0) return { kind: 'sni', name: name.toLowerCase().replace(/\.$/, '') };
      }
      return { kind: 'no-sni' };
    }
    return { kind: 'no-sni' };
  } catch {
    return { kind: 'bad' };
  }
}

/** Builds a minimal ClientHello naming `name`, for tests and the boot probe's own check. */
export function clientHello(name: string | null): Uint8Array {
  const enc = new TextEncoder().encode(name ?? '');
  const ext: number[] = [];
  if (name !== null) {
    const entry = [0x00, enc.length >> 8, enc.length & 0xff, ...enc];
    const list = [entry.length >> 8, entry.length & 0xff, ...entry];
    ext.push(0x00, 0x00, list.length >> 8, list.length & 0xff, ...list);
  }
  const body = [
    0x03,
    0x03,
    ...new Array(32).fill(7),
    0x00, // session id
    0x00,
    0x02,
    0x13,
    0x01, // one cipher suite
    0x01,
    0x00, // null compression
    ext.length >> 8,
    ext.length & 0xff,
    ...ext,
  ];
  const hs = [0x01, 0x00, body.length >> 8, body.length & 0xff, ...body];
  return new Uint8Array([0x16, 0x03, 0x01, hs.length >> 8, hs.length & 0xff, ...hs]);
}
