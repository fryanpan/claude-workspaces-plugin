/**
 * Every request the server makes leaves through this module.
 *
 * Security review finding H4: the server fetched any address it was handed,
 * so a planted link — a webhook URL, a push endpoint — could make it read a
 * service on the Mac, the LAN, the tailnet or a cloud metadata endpoint, and
 * hand back what it found. There are three ways out, and each one says why
 * the address it accepts is safe:
 *
 *  - **`publicFetch`** — for an address that came from content or a person.
 *    It resolves the host itself, refuses the request if ANY address the name
 *    resolves to is loopback, private (RFC 1918), CGNAT (which is also the
 *    tailnet), unique-local, link-local (cloud metadata lives there),
 *    unspecified, multicast, reserved or Fly-internal (`*.internal`,
 *    `fdaa::/16`), and then connects to the address it checked rather than
 *    letting the request resolve the name a second time. So a name that
 *    answers public for the check and private for the connection — DNS
 *    rebinding — reaches the public address or nothing. It follows no
 *    redirect, and a redirect whose `Location` lands on a refused address is
 *    refused outright, so a caller cannot follow it by hand.
 *  - **`fixedHostFetch`** — for the vendors the server is built to call
 *    (`VENDOR_HOSTS`) and the hosts an operator configured
 *    (`configuredHostFetch`). The host is a constant or the operator's own
 *    config, never a value a reader typed, so nothing is resolved here.
 *  - **`loopbackFetch(purpose)`** — for an origin on this machine, and only
 *    for the purposes named in `LoopbackPurpose`: a dev server attached for
 *    review, and this server calling itself. The host must be written as
 *    loopback (`127.0.0.1`, `localhost`, `[::1]`); nothing is resolved, and it
 *    follows no redirect either.
 *
 * `bun run check:outbound-fetch` fails on a reference to the global `fetch`
 * anywhere in `packages/server/src` but here. One request it cannot see:
 * `jose`'s `createRemoteJWKSet` fetches the Cloudflare Access certs for the
 * configured team domain itself (`middleware/cf-access.ts`); that host is the
 * operator's config, the same trust as `configuredHostFetch`.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Why an address is not public. `public` is the only verdict that passes. */
export type AddressRange =
  | 'public'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'unique-local'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'fly-internal';

/** A request the guard would not make. A fetch failure to every caller. */
export class OutboundRefused extends Error {
  constructor(
    readonly url: string,
    readonly range: Exclude<AddressRange, 'public'> | 'scheme' | 'host',
    detail: string,
  ) {
    super(`outbound request refused: ${detail}`);
    this.name = 'OutboundRefused';
  }
}

// ── Address classification ──────────────────────────────────────────────

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] ?? 0) << 24) | ((p[1] ?? 0) << 16) | ((p[2] ?? 0) << 8) | (p[3] ?? 0)) >>> 0;
}

const V4_RANGES: [string, number, Exclude<AddressRange, 'public'>][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function classifyV4(ip: string): AddressRange {
  const n = v4ToInt(ip);
  for (const [base, bits, range] of V4_RANGES) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return range;
  }
  return 'public';
}

/** An IPv6 address as eight 16-bit groups. Input is already `isIP` 6. */
function v6Groups(ip: string): number[] {
  let s = ip;
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) {
    // A dotted IPv4 tail is the last two groups written another way.
    const n = v4ToInt(s.slice(lastColon + 1));
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

function classifyV6(ip: string): AddressRange {
  const g = v6Groups(ip);
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h7 = 0, h8 = 0] = g;
  const zeroTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return 'unspecified';
  if (zeroTo(7) && h8 === 1) return 'loopback';
  // An IPv4 address carried inside IPv6 is judged as that IPv4 address:
  // mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:ab:cd::).
  if (zeroTo(5) && f === 0xffff) return classifyV4(embeddedV4(h7, h8));
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return classifyV4(embeddedV4(h7, h8));
  }
  if (a === 0x2002) return classifyV4(embeddedV4(b, c));
  if (zeroTo(6)) return 'reserved'; // IPv4-compatible, deprecated
  if (a === 0xfdaa) return 'fly-internal';
  if ((a & 0xfe00) === 0xfc00) return 'unique-local';
  if ((a & 0xffc0) === 0xfe80) return 'link-local';
  if ((a & 0xffc0) === 0xfec0) return 'private'; // site-local, deprecated
  if ((a & 0xff00) === 0xff00) return 'multicast';
  if (a === 0x2001 && b === 0x0db8) return 'documentation';
  if (a === 0x2001 && b === 0) return 'reserved'; // Teredo: hides an IPv4 address
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return 'reserved'; // discard
  if (a === 0x64 && b === 0xff9b) return 'reserved'; // local-use NAT64
  return 'public';
}

/** Which range an IP literal sits in; `reserved` for anything not an IP. */
export function classifyAddress(address: string): AddressRange {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = isIP(bare);
  if (kind === 4) return classifyV4(bare);
  if (kind === 6) return classifyV6(bare.toLowerCase());
  return 'reserved';
}

// ── The public path ──────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * A guarded fetch, typed as the global so it drops in wherever a module takes
 * an injectable `typeof fetch`. It takes the URL as a string or URL: a
 * `Request` would carry a method, headers and body this module would have to
 * copy across, and no caller passes one, so it is refused rather than half
 * honoured. `preconnect` does nothing, because it would open a socket to an
 * address nobody checked.
 */
export type GuardedFetch = typeof fetch;

function guarded(fn: (url: URL, init: RequestInit | undefined) => Promise<Response>): GuardedFetch {
  const call = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      return Promise.reject(new TypeError('outbound fetch takes a URL, not a Request'));
    }
    let url: URL;
    try {
      url = new URL(String(input));
    } catch (err) {
      return Promise.reject(err);
    }
    return fn(url, init);
  };
  return Object.assign(call, { preconnect: () => {} }) as GuardedFetch;
}

export interface PublicFetchOptions {
  /** Name → addresses. Default: the system resolver, every address. */
  resolve?: Resolve;
  /** Makes the pinned request. Default: the global fetch. */
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Ranges this instance lets through. Empty in production; a test that has
   * to stand up a sink on 127.0.0.1 names `loopback` here, which leaves
   * every other check — and the pinning — in force.
   */
  permit?: ReadonlySet<Exclude<AddressRange, 'public'>>;
}

const systemResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });

const RESOLVE_TIMEOUT_MS = 5_000;

function hostLabel(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** A name refused before it is resolved: these never mean a public host. */
function namedRange(host: string): Exclude<AddressRange, 'public'> | null {
  const h = host.replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (h === 'internal' || h.endsWith('.internal')) return 'fly-internal';
  return null;
}

function withDeadline<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), RESOLVE_TIMEOUT_MS);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The address a public request may connect to, or a refusal. Every address
 * the name resolves to must pass, so a name with one private record among
 * public ones is refused rather than raced.
 */
async function pinnedAddress(
  url: URL,
  resolve: Resolve,
  permit: ReadonlySet<string>,
  signal: AbortSignal | null | undefined,
): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundRefused(url.href, 'scheme', `${url.protocol} is not http or https`);
  }
  const host = hostLabel(url.hostname);
  if (host === '') throw new OutboundRefused(url.href, 'host', 'no host');
  const named = namedRange(host);
  if (named && !permit.has(named)) {
    throw new OutboundRefused(url.href, named, `${host} is a ${named} name`);
  }
  const addresses: ResolvedAddress[] = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await withDeadline(resolve(host), signal);
  if (addresses.length === 0) throw new OutboundRefused(url.href, 'host', `${host} has no address`);
  for (const { address } of addresses) {
    const range = classifyAddress(address);
    if (range !== 'public' && !permit.has(range)) {
      throw new OutboundRefused(url.href, range, `${host} resolves to ${range} ${address}`);
    }
  }
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  return (first as ResolvedAddress).address;
}

/** The same URL with its host replaced by the address that was checked. */
function pinnedUrl(url: URL, address: string): string {
  const out = new URL(url.href);
  out.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return out.href;
}

function headersWithHost(init: RequestInit | undefined, host: string): Headers {
  const headers = new Headers(init?.headers);
  // Bun checks the server certificate against the Host header, so a pinned
  // https request still proves it reached the named host.
  headers.set('host', host);
  return headers;
}

/** A fetch that reaches public addresses only. See the file header. */
export function createPublicFetch(opts: PublicFetchOptions = {}): GuardedFetch {
  const resolve = opts.resolve ?? systemResolve;
  const transport = opts.transport ?? ((url, init) => globalThis.fetch(url, init));
  const permit: ReadonlySet<string> = opts.permit ?? new Set();
  return guarded(async (url, init) => {
    const address = await pinnedAddress(url, resolve, permit, init?.signal);
    const tls = url.protocol === 'https:' ? { tls: { serverName: hostLabel(url.hostname) } } : {};
    const res = await transport(pinnedUrl(url, address), {
      ...init,
      ...tls,
      headers: headersWithHost(init, url.host),
      redirect: 'manual',
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location !== null) {
      let next: URL | null = null;
      try {
        next = new URL(location, url);
      } catch {
        // Not a URL: nothing to follow and nothing to refuse.
      }
      if (next) {
        try {
          await pinnedAddress(next, resolve, permit, init?.signal);
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw err;
        }
      }
    }
    return res;
  });
}

/** The production public fetch: system resolver, no permitted ranges. */
export const publicFetch: GuardedFetch = createPublicFetch();

// ── The fixed-host path ──────────────────────────────────────────────────

/**
 * The vendors the server is built to call. An entry starting with a dot
 * admits that domain's subdomains: Recall's API host names its region
 * (`us-east-1.recall.ai`), and an Access team domain is the operator's own
 * name under `cloudflareaccess.com`.
 */
export const VENDOR_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'api.elevenlabs.io',
  'api.cloudflare.com',
  'api.postmarkapp.com',
  'api.github.com',
  'api.assemblyai.com',
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
  'slack.com',
  '.recall.ai',
];

/** Is `hostname` one of `VENDOR_HOSTS`? */
export function isVendorHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return VENDOR_HOSTS.some((v) =>
    v.startsWith('.') ? h.endsWith(v) && h.length > v.length : h === v,
  );
}

/** Requests to the vendors in `VENDOR_HOSTS`, over https only. */
export const fixedHostFetch: GuardedFetch = guarded(async (url, init) => {
  if (url.protocol !== 'https:' || !isVendorHost(url.hostname)) {
    throw new OutboundRefused(url.href, 'host', `${url.host} is not a vendor host`);
  }
  return globalThis.fetch(url.href, init);
});

/**
 * Requests to origins an operator configured — another board server for Home
 * (`home-remotes.ts`), the servers the org relay carries messages between
 * (`org-relay/`). The origins come from the operator's config file, never
 * from content, so a co-located server on loopback is allowed when it was
 * configured. No redirect is followed.
 */
export function configuredHostFetch(origins: Iterable<string>): GuardedFetch {
  const allowed = new Set(Array.from(origins, (o) => new URL(o).origin));
  return guarded(async (url, init) => {
    if (!allowed.has(url.origin)) {
      throw new OutboundRefused(url.href, 'host', `${url.origin} is not a configured host`);
    }
    return globalThis.fetch(url.href, { ...init, redirect: 'manual' });
  });
}

// ── The loopback path ────────────────────────────────────────────────────

/**
 * Why this server calls an origin on this machine. Each is a flow that
 * exists today and would break if loopback were simply refused:
 *
 *  - `attached-app` — a dev server bound for review with `attach_app`: the
 *    app proxy and its probe (`routes/apps.ts`), the page-address check
 *    (`page-thread.ts`) and an app's `say` (`app-voice/say.ts`). The origin
 *    was checked as loopback when it was attached (`parseLoopbackOrigin`).
 *  - `own-server` — this server calling its own REST routes: the hosted MCP
 *    connector (`connector/session-factory.ts`) and the review-migration
 *    script (`review-migration.ts`).
 */
export type LoopbackPurpose = 'attached-app' | 'own-server';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Requests to a loopback origin, for one named purpose. */
export function loopbackFetch(purpose: LoopbackPurpose): GuardedFetch {
  return guarded(async (url, init) => {
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new OutboundRefused(url.href, 'host', `${url.host} is not loopback (${purpose})`);
    }
    return globalThis.fetch(url.href, { ...init, redirect: 'manual' });
  });
}
