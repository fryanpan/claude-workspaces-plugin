/**
 * The git smart-HTTP protocol, as far as the GitHub proxy (`git-proxy.ts`)
 * reads it: which repo and service a request names, the ref updates a push
 * asks for, and the capability that makes a pushed pack whole. No I/O here.
 */
import { isRepoName } from './git-proxy-lead.ts';

export type Service = 'git-upload-pack' | 'git-receive-pack';

export interface RepoRequest {
  /** `owner/name`, as the client spelled it. */
  repo: string;
  /** `info/refs` (the GET that starts every fetch and push) or the service's POST. */
  kind: 'refs' | 'rpc';
  service: Service;
}

const SERVICES: readonly Service[] = ['git-upload-pack', 'git-receive-pack'];

/**
 * The repo and service a request names, or null for anything else: the
 * dumb-HTTP paths, an encoded or dot step, a third path segment.
 */
export function parseRepoRequest(method: string, rawUrl: string): RepoRequest | null {
  // Judged before URL parsing, which would resolve a dot step away.
  const rawPath = rawUrl.split('?')[0] ?? '';
  if (!rawPath.startsWith('/') || /%|\\|\/\.\.?(\/|$)/.test(rawPath)) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://proxy.invalid');
  } catch {
    return null;
  }
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname,
  );
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  if (!isRepoName(repo)) return null;
  if (m[3] === 'info/refs') {
    const service = url.searchParams.get('service');
    if (method !== 'GET' || !SERVICES.includes(service as Service)) return null;
    return { repo, kind: 'refs', service: service as Service };
  }
  if (method !== 'POST') return null;
  return { repo, kind: 'rpc', service: m[3] as Service };
}

/** The password of a Basic `Authorization` header, or null. */
export function basicPassword(header: string | undefined): string | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m?.[1]) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** Every occurrence of each secret replaced, so an error text can be logged or returned. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
  return out;
}

/** The forms the owner's credential travels in, for `redact`. */
export function credentialForms(credential: string): string[] {
  return [credential, Buffer.from(`x-access-token:${credential}`).toString('base64')];
}

export function basicHeader(credential: string): string {
  return `Basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`;
}

/** One pkt-line: its payload, or null for a flush (`0000`). */
interface Pkt {
  payload: Buffer | null;
  end: number;
}

function readPkt(buf: Buffer, at: number): Pkt | string {
  if (at + 4 > buf.length) return 'the request ends inside a pkt-line';
  const hex = buf.toString('latin1', at, at + 4);
  if (!/^[0-9a-f]{4}$/.test(hex)) return 'the request is not pkt-lines';
  const len = Number.parseInt(hex, 16);
  if (len === 0) return { payload: null, end: at + 4 };
  if (len < 4 || at + len > buf.length) return 'a pkt-line has a bad length';
  return { payload: buf.subarray(at + 4, at + len), end: at + len };
}

export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isZero(sha: string): boolean {
  return /^0+$/.test(sha);
}

/**
 * The ref updates and the pack of a `git-receive-pack` request body. The
 * body is the commands, a flush, the push options and a flush if the client
 * asked for them, then the pack. A body this cannot read is refused: the
 * proxy forwards nothing it has not checked.
 */
export function parseReceivePack(
  body: Buffer,
): { ok: true; updates: RefUpdate[]; pack: Buffer } | { ok: false; error: string } {
  const updates: RefUpdate[] = [];
  let at = 0;
  let caps: string[] = [];
  for (;;) {
    const pkt = readPkt(body, at);
    if (typeof pkt === 'string') return { ok: false, error: pkt };
    at = pkt.end;
    if (pkt.payload === null) break;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (updates.length === 0 && line.startsWith('shallow ')) continue;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (updates.length > 0) return { ok: false, error: 'capabilities after the first command' };
      caps = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
    }
    const [old, neu, ref, extra] = line.split(' ');
    if (!old || !neu || !ref || extra !== undefined || !SHA.test(old) || !SHA.test(neu))
      return { ok: false, error: `not a ref update: ${line.slice(0, 80)}` };
    if (!ref.startsWith('refs/')) return { ok: false, error: `not a ref: ${ref}` };
    updates.push({ old, new: neu, ref });
  }
  // The probe git sends before a large push is a bare flush: no commands.
  if (updates.length === 0) return { ok: true, updates, pack: body.subarray(at) };
  if (caps.includes('push-options')) {
    for (;;) {
      const pkt = readPkt(body, at);
      if (typeof pkt === 'string') return { ok: false, error: pkt };
      at = pkt.end;
      if (pkt.payload === null) break;
    }
  }
  const pack = body.subarray(at);
  if (pack.length > 0 && pack.toString('latin1', 0, 4) !== 'PACK')
    return { ok: false, error: 'what follows the commands is not a pack' };
  return { ok: true, updates, pack };
}

/**
 * The `info/refs` answer for `git-receive-pack`, with `no-thin` added to the
 * capabilities. A client must then send a pack that holds every object its
 * deltas name, so the proxy can read the pushed commits without fetching
 * anything from GitHub. Null if the answer is not a ref advertisement.
 */
export function addNoThin(advert: Buffer): Buffer | null {
  const first = readPkt(advert, 0);
  if (typeof first === 'string' || first.payload === null) return null;
  if (!first.payload.toString('utf8').startsWith('# service=')) return null;
  const flush = readPkt(advert, first.end);
  if (typeof flush === 'string' || flush.payload !== null) return null;
  const refs = readPkt(advert, flush.end);
  if (typeof refs === 'string' || refs.payload === null) return null;
  const line = refs.payload.toString('utf8');
  const nul = line.indexOf('\0');
  if (nul < 0) return null;
  const nl = line.endsWith('\n') ? '\n' : '';
  const body = line.slice(0, line.length - nl.length);
  const caps = body.slice(nul + 1).split(' ');
  const out = caps.includes('no-thin') ? body : `${body} no-thin`;
  const payload = Buffer.from(`${out}${nl}`, 'utf8');
  const len = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([
    advert.subarray(0, flush.end),
    Buffer.from(len, 'latin1'),
    payload,
    advert.subarray(refs.end),
  ]);
}

/**
 * The ref `HEAD` points at, from the `info/refs` answer for
 * `git-upload-pack` in protocol v0: its first line's `symref=HEAD:<ref>`
 * capability. `git-receive-pack`'s answer names no HEAD, so the proxy asks
 * for this one. Null for an empty repo or an answer it cannot read.
 */
export function headSymref(advert: Buffer): string | null {
  const first = readPkt(advert, 0);
  if (typeof first === 'string' || first.payload === null) return null;
  const flush = readPkt(advert, first.end);
  if (typeof flush === 'string' || flush.payload !== null) return null;
  const refs = readPkt(advert, flush.end);
  if (typeof refs === 'string' || refs.payload === null) return null;
  const line = refs.payload.toString('utf8').replace(/\n$/, '');
  const nul = line.indexOf('\0');
  if (nul < 0) return null;
  for (const cap of line.slice(nul + 1).split(' '))
    if (cap.startsWith('symref=HEAD:refs/')) return cap.slice('symref=HEAD:'.length);
  return null;
}
