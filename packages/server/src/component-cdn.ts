/**
 * The `https://` modules a doc's component imports, fetched once and kept
 * (design decision 6).
 *
 * An author writes `import { scaleLinear } from 'https://esm.sh/d3-scale@4.0.2'`.
 * The address must name an allowed host (esm.sh) and an exact version: a range
 * (`@^4`), a partial version (`@4.0`) or none at all is refused with the form
 * that would be accepted. The module is fetched the first time a build needs
 * it, stored in the data dir with its sha256, and every later build reads the
 * stored copy. esm.sh can rebuild a version, and the modules a version imports
 * name their own dependencies by range (`/lit@^3.2.1`), so the stored copy is
 * what keeps a component the same after an editor added it.
 *
 * Modules the first one imports (`/@scope/pkg@1.2.3/es2022/x.mjs`) are
 * resolved against it and must stay on the same host; they are fetched and
 * stored the same way, without the exact-version rule, since the author did
 * not write them.
 *
 * The request leaves through `configuredHostFetch` (`outbound-fetch.ts`): the
 * host is a constant here, no redirect is followed, and a test hands in its
 * own fetch. Each fetch is bounded: it is given up after
 * `CDN_FETCH_TIMEOUT_MS`, headers and body alike, and the body is read in
 * chunks and abandoned past `MAX_CDN_MODULE_BYTES`, so a stalled or endless
 * answer cannot hold a doc's build.
 *
 * A module is stored, and asked for, under its address without the query.
 * An author's import may not carry one; esm.sh writes `?target=es2022` on
 * the imports inside a module, and the request adds that back. So the
 * number of stored modules is bounded by the paths esm.sh serves, not by
 * the queries a module could spell.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredHostFetch } from './outbound-fetch.ts';

/** Hosts a component may import from. */
export const CDN_HOSTS: readonly string[] = ['esm.sh'];

/** The most one fetched module may weigh. */
export const MAX_CDN_MODULE_BYTES = 8 * 1024 * 1024;

/** How long one module's fetch, headers and body, may take. */
export const CDN_FETCH_TIMEOUT_MS = 20_000;

export type CdnFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const productionFetch = configuredHostFetch(CDN_HOSTS.map((h) => `https://${h}`));

export const defaultCdnFetch: CdnFetch = (url, init) => productionFetch(url, init);

/** `url` without its query or fragment: the key a module is stored and
 *  asked for under. */
export function cdnModuleKey(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Why an `https://` import an author wrote is refused, or null when it is an
 * allowed host at an exact version.
 */
export function cdnImportRefusal(spec: string): string | null {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return `'${spec}' is not an address`;
  }
  if (url.protocol !== 'https:') return `'${spec}' is not https: write it as https://esm.sh/…`;
  if (!CDN_HOSTS.includes(url.hostname)) {
    return `'${spec}' is not on an allowed host: import it from https://esm.sh/<package>@<exact version>`;
  }
  if (url.search || url.hash) {
    return `'${spec}' carries a query or fragment, which is refused: import the address without it`;
  }
  const m = /^\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/?#]*))?/.exec(url.pathname);
  const pkg = m?.[1];
  if (!pkg) return `'${spec}' names no package: write https://esm.sh/<package>@<exact version>`;
  const version = m?.[2];
  const pinned = `https://${url.hostname}/${pkg}@<major>.<minor>.<patch>`;
  if (version === undefined || version === '') {
    return `'${spec}' has no version: pin one exactly, as ${pinned}`;
  }
  if (!EXACT.test(version)) {
    return `'${spec}' asks for version '${version}', which is a range or a tag: pin an exact version, as ${pinned}`;
  }
  return null;
}

/** Resolve a path a fetched module imports. Null when it leaves the host. */
export function resolveCdnImport(spec: string, importer: string): string | null {
  let url: URL;
  try {
    url = new URL(spec, importer);
  } catch {
    return null;
  }
  const from = new URL(importer);
  if (url.protocol !== 'https:' || url.host !== from.host) return null;
  return cdnModuleKey(url.href);
}

/** The address actually requested: esm.sh picks its build by User-Agent, so
 *  the browser target is named outright. */
function requestUrl(url: string): string {
  const u = new URL(url);
  if (
    u.hostname === 'esm.sh' &&
    !u.searchParams.has('target') &&
    !/\/es20\d\d\//.test(u.pathname)
  ) {
    u.searchParams.set('target', 'es2022');
  }
  return u.href;
}

interface Stored {
  url: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export class CdnStore {
  private readonly inFlight = new Map<string, Promise<string>>();
  /** How many modules were fetched rather than read from the store. */
  fetched = 0;

  constructor(
    private readonly dir: string,
    private readonly fetcher: CdnFetch = defaultCdnFetch,
    private readonly timeoutMs = CDN_FETCH_TIMEOUT_MS,
  ) {}

  /** The module's text: the stored copy, or fetched and stored now. */
  load(address: string): Promise<string> {
    const url = cdnModuleKey(address);
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const p = this.loadOnce(url).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, p);
    return p;
  }

  private paths(url: string): { body: string; meta: string } {
    const key = sha256(url);
    return { body: join(this.dir, `${key}.js`), meta: join(this.dir, `${key}.json`) };
  }

  private async loadOnce(url: string): Promise<string> {
    const { body, meta } = this.paths(url);
    const stored = this.readStored(body, meta);
    if (stored !== null) return stored;
    const bytes = await this.fetchBounded(url);
    this.fetched++;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const record: Stored = {
      url,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(`${body}.tmp`, bytes);
    renameSync(`${body}.tmp`, body);
    writeFileSync(`${meta}.tmp`, JSON.stringify(record));
    renameSync(`${meta}.tmp`, meta);
    return new TextDecoder().decode(bytes);
  }

  /** The module's bytes, given up after the timeout or past the size cap. */
  private async fetchBounded(url: string): Promise<Uint8Array> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error(`${url} did not answer within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref?.();
    });
    // A fetch that ignores the signal still loses the race.
    timedOut.catch(() => {});
    try {
      const res = await Promise.race([
        this.fetcher(requestUrl(url), { signal: ctl.signal }),
        timedOut,
      ]);
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`${url} answered ${res.status}`);
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CDN_MODULE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`${url} is over the ${MAX_CDN_MODULE_BYTES}-byte limit`);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return bytes;
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
  }

  /** The stored copy, or null when there is none. A copy whose bytes no
   *  longer match the hash recorded beside it is refused, never refetched:
   *  the point of storing it is that it does not change. */
  private readStored(body: string, meta: string): string | null {
    let record: Stored;
    try {
      record = JSON.parse(readFileSync(meta, 'utf8')) as Stored;
    } catch {
      return null;
    }
    const bytes = readFileSync(body);
    if (sha256(bytes) !== record.sha256) {
      throw new Error(`the stored copy of ${record.url} no longer matches its sha256`);
    }
    return bytes.toString('utf8');
  }
}
