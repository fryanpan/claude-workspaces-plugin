/**
 * The transcript store's daily check: for one UTC day, every chunk of every
 * file a host's inventory names is opened with the Mac's keys and judged.
 *
 * A day's window, per file, runs from the size its inventory gave at the
 * day's start (`<day>`) to the size at its end (`<day + 1>`); with `all`, the
 * monthly pass, from byte 0. The chunks that cover the window are listed,
 * opened and laid end to end:
 *
 *   invalid      a chunk does not open, decompress, parse as JSON lines and
 *                end on a line break, or its bytes differ from its manifest's
 *   deleted      bytes the window needs are missing, and a manifest names the
 *                chunk that held them
 *   skipped      bytes the window needs are missing, and no manifest names any
 *                chunk for them: they were never sent
 *   conflicting  two chunks at one offset hold different bytes
 *   no inventory a host the check was told about wrote none for the day's end
 *
 * Those five fail the check and each raises a warning to Sentry. Three more
 * are counted and listed only: a duplicate (two chunks at one offset with the
 * same bytes, which is what a put whose answer was lost leaves), a stray (a
 * good chunk no manifest names) and a key with several versions.
 *
 * Output is counts only: no file, board, session or key name leaves here.
 */
import { createHash } from 'node:crypto';
import type { Inventory, InventoryFile } from './store-inventory.ts';
import { inventoryKey } from './store-inventory.ts';
import { type Bucket, S3Error } from './store-s3.ts';
import { type SentryEvent, raiseToSentry } from './store-sentry.ts';
import { type Manifest, type ManifestChunk, openChunk, utcDay } from './store-upload.ts';

export interface CheckOptions {
  /** A credential that may read and list. */
  bucket: Bucket;
  /** Every host that holds a writing credential. */
  hosts: readonly string[];
  day: string;
  /** Every identity the Mac holds; each chunk is opened with whichever fits. */
  identities: readonly string[];
  all?: boolean;
}

export const FAILURES = [
  'invalid',
  'deleted',
  'skipped',
  'conflicting',
  'missingInventory',
] as const;
type Failure = (typeof FAILURES)[number];

export interface CheckCounts extends Record<Failure, number> {
  hosts: number;
  files: number;
  chunksOpened: number;
  bytesChecked: number;
  duplicates: number;
  strays: number;
  severalVersions: number;
}

const DAY_MS = 86_400_000;
const shiftDay = (day: string, by: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fileId = (f: Pick<InventoryFile, 'kind' | 'folder' | 'name' | 'gen'>) =>
  `${f.kind}/${f.folder}/${f.name}/${f.gen}`;

function opened(body: Uint8Array, identities: readonly string[]): Buffer | null {
  for (const id of identities) {
    try {
      return openChunk(body, id);
    } catch {}
  }
  return null;
}

/** Whole JSON lines, ending on a line break. */
function wellFormed(plain: Buffer): boolean {
  if (plain.length === 0 || plain[plain.length - 1] !== 0x0a) return false;
  for (const line of plain.toString('utf8').slice(0, -1).split('\n')) {
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

/** A sealed JSON object, or null when there is no such key. Throws when it does not open. */
async function sealedJson<T>(b: Bucket, key: string, ids: readonly string[]): Promise<T | null> {
  let body: Buffer;
  try {
    body = await b.get(key);
  } catch (err) {
    if (err instanceof S3Error && err.status === 404) return null;
    throw err;
  }
  const plain = opened(body, ids);
  if (!plain) throw new Error('a bookkeeping object did not open with any key the Mac holds');
  return JSON.parse(plain.toString('utf8')) as T;
}

const CHUNK_NAME = {
  transcripts: /^(?:rewrite-(\d+)\/)?(\d+)-[0-9a-f]+\.jsonl\.zst\.cw$/,
  events: /^\d{4}-\d{2}-\d{2}\/(?:rewrite-(\d+)\/)?(\d+)-[0-9a-f]+\.jsonl\.zst\.cw$/,
};

/** The offset of a chunk of `f` named `rel` under its prefix, or null when it is not one. */
function offsetIn(f: InventoryFile, rel: string): number | null {
  const m = CHUNK_NAME[f.kind].exec(rel);
  if (!m || Number(m[1] ?? 0) !== f.gen) return null;
  return Number(m[2]);
}

interface Good {
  offset: number;
  len: number;
  sha: string;
}

export async function runCheck(opts: CheckOptions): Promise<CheckCounts> {
  const c: CheckCounts = {
    hosts: 0,
    files: 0,
    chunksOpened: 0,
    bytesChecked: 0,
    invalid: 0,
    deleted: 0,
    skipped: 0,
    conflicting: 0,
    missingInventory: 0,
    duplicates: 0,
    strays: 0,
    severalVersions: 0,
  };
  const ids = opts.identities;
  for (const host of opts.hosts) {
    c.hosts++;
    const end = await sealedJson<Inventory>(
      opts.bucket,
      inventoryKey(host, shiftDay(opts.day, 1)),
      ids,
    );
    if (!end) {
      c.missingInventory++;
      continue;
    }
    const start = opts.all
      ? null
      : await sealedJson<Inventory>(opts.bucket, inventoryKey(host, opts.day), ids);
    const manifestPrefixes = opts.all
      ? [`${host}/manifests/`]
      : [shiftDay(opts.day, -1), opts.day].map((d) => `${host}/manifests/${d}/`);
    const manifests = new Map<string, Map<string, ManifestChunk>>();
    for (const prefix of manifestPrefixes) {
      for (const o of await opts.bucket.list(prefix)) {
        const m = await sealedJson<Manifest>(opts.bucket, o.key, ids);
        if (!m) continue;
        const byKey = manifests.get(fileId(m)) ?? new Map<string, ManifestChunk>();
        for (const ch of m.chunks) byKey.set(ch.key, ch);
        manifests.set(fileId(m), byKey);
      }
    }
    for (const f of end.files) {
      const from = start?.files.find((s) => fileId(s) === fileId(f))?.size ?? 0;
      if (f.size <= from) continue;
      c.files++;
      await checkFile(opts, c, host, f, from, manifests.get(fileId(f)) ?? new Map());
    }
  }
  return c;
}

async function checkFile(
  opts: CheckOptions,
  c: CheckCounts,
  host: string,
  f: InventoryFile,
  from: number,
  manifest: ReadonlyMap<string, ManifestChunk>,
): Promise<void> {
  const to = f.size;
  const prefix = `${host}/${f.kind}/${f.folder}/${f.name}/`;
  const listed = (await opts.bucket.list(prefix))
    .map((o) => ({ key: o.key, offset: offsetIn(f, o.key.slice(prefix.length)) }))
    .filter((o): o is { key: string; offset: number } => o.offset !== null)
    .sort((a, b) => a.offset - b.offset);
  const present = new Set(listed.map((o) => o.key));
  // The chunk that may straddle the window's start, and every one inside it.
  const floor = listed.reduce((m, o) => (o.offset <= from ? o.offset : m), from);
  const inWindow = listed.filter((o) => o.offset >= floor && o.offset < to);
  const good: Good[] = [];
  const bad: { start: number; end: number }[] = [];
  for (const o of inWindow) {
    const plain = opened(await opts.bucket.get(o.key), opts.identities);
    c.chunksOpened++;
    const entry = manifest.get(o.key);
    if (plain) c.bytesChecked += plain.length;
    if (!plain || !wellFormed(plain) || (entry && entry.sha256 !== sha(plain))) {
      c.invalid++;
      const next = listed.find((x) => x.offset > o.offset)?.offset ?? to;
      bad.push({ start: o.offset, end: entry ? entry.offset + entry.bytes : next });
      continue;
    }
    if (!entry) c.strays++;
    good.push({ offset: o.offset, len: plain.length, sha: sha(plain) });
  }
  const byOffset = new Map<number, Good[]>();
  for (const g of good) byOffset.set(g.offset, [...(byOffset.get(g.offset) ?? []), g]);
  const ranges: Good[] = [];
  for (const [, same] of [...byOffset].sort((a, b) => a[0] - b[0])) {
    const [first] = same;
    if (!first) continue;
    if (same.every((g) => g.sha === first.sha)) c.duplicates += same.length - 1;
    else c.conflicting++;
    ranges.push(first);
  }
  const gaps: [number, number][] = [];
  let pos = from;
  for (const r of ranges) {
    if (r.offset > pos && pos < to) gaps.push([pos, Math.min(r.offset, to)]);
    pos = Math.max(pos, r.offset + r.len);
  }
  if (pos < to) gaps.push([pos, to]);
  for (const [a, b] of gaps) {
    const overlaps = (s: number, e: number) => s < b && e > a;
    if (bad.some((x) => overlaps(x.start, x.end))) continue;
    const gone = [...manifest.values()].filter(
      (m) => !present.has(m.key) && overlaps(m.offset, m.offset + m.bytes),
    );
    if (gone.length > 0) c.deleted += gone.length;
    else c.skipped++;
  }
  const windowKeys = new Set(inWindow.map((o) => o.key));
  for (const m of manifest.values()) {
    if (m.offset >= floor && m.offset < to) windowKeys.add(m.key);
  }
  const versions = new Map<string, number>();
  for (const v of await opts.bucket.listVersions(prefix)) {
    if (windowKeys.has(v.key)) versions.set(v.key, (versions.get(v.key) ?? 0) + 1);
  }
  c.severalVersions += [...versions.values()].filter((n) => n > 1).length;
}

const LABEL: Record<Failure, string> = {
  invalid: 'chunks that do not open, parse or match their manifest',
  deleted: 'chunks a manifest names that are gone',
  skipped: 'ranges no chunk holds and no manifest names',
  conflicting: 'offsets with two different chunks',
  missingInventory: 'hosts with no inventory',
};

/** One counts-only line for the log. */
export function summary(day: string, c: CheckCounts): string {
  return [
    `${day}: ${c.hosts} hosts, ${c.files} files, ${c.chunksOpened} chunks opened (${c.bytesChecked} bytes)`,
    `failures: invalid ${c.invalid}, deleted ${c.deleted}, skipped ${c.skipped}, conflicting ${c.conflicting}, no inventory ${c.missingInventory}`,
    `listed: duplicates ${c.duplicates}, strays ${c.strays}, keys with several versions ${c.severalVersions}`,
  ].join('; ');
}

/**
 * Raises one warning per failing kind to the DSN's project. Without a DSN
 * nothing is raised, and `failed` still says whether it should have been.
 */
export async function checkAndAlert(
  c: CheckCounts,
  day: string,
  dsn: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ failed: boolean; raised: number; lines: string[] }> {
  const lines: string[] = [];
  let raised = 0;
  const failing = FAILURES.filter((k) => c[k] > 0);
  for (const k of failing) {
    const event: SentryEvent = {
      level: 'warning',
      message: `Transcript store check ${day}: ${c[k]} ${LABEL[k]}`,
      fingerprint: ['transcript-store-check', k],
      tags: { check: k, day },
      extra: { ...c },
    };
    if (!dsn) {
      lines.push(`would raise (no DSN): ${event.message}`);
      continue;
    }
    const status = await raiseToSentry(dsn, event, fetchImpl);
    if (status >= 200 && status < 300) raised++;
    lines.push(`raised to Sentry (HTTP ${status}): ${event.message}`);
  }
  return { failed: failing.length > 0, raised, lines };
}
