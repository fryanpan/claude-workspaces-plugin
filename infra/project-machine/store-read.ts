#!/usr/bin/env bun
/**
 * Read the transcript store from the Mac, with the read-and-list credential
 * and the identities `handoff:pull` stored after the first `fly-provision.yml`
 * run made the store (`deploy-store.ts`).
 *
 *   bun run store:read list --host <app>            count a machine's objects, open one of each kind
 *   bun run store:read check [--day <YYYY-MM-DD>] --hosts <app>[,<app>…] [--all]
 *                                                   the daily check, raising to Sentry
 *
 * `list` reads both of the machine's hosts, `<app>/` and `<app>_lead/`. It
 * prints keys, counts, byte counts, line counts and a sha256 of what it
 * opened, and never a line of content. `check` opens everything for the day
 * (yesterday, UTC, by default), prints counts only, and raises to the DSN in
 * `CW_SENTRY_SERVER_DSN`; without one it says what it would have raised. Each
 * exits 1 when it fails.
 */
import { createHash } from 'node:crypto';
import { keychainRead } from './mac-ops.ts';
import { checkAndAlert, runCheck, summary } from './store-check.ts';
import { storeHosts } from './store-plan.ts';
import { type Bucket, s3Bucket } from './store-s3.ts';
import { readCredential, storeNames } from './store-setup.ts';
import { openChunk, utcDay } from './store-upload.ts';

export interface OpenedChunk {
  key: string;
  sealedBytes: number;
  plainBytes: number;
  lines: number;
  sha256: string;
}

export interface HostReading {
  host: string;
  /** Objects under the host, by the key's second segment (`transcripts`, `events`, …). */
  counts: Record<string, number>;
  /** The last-listed transcript and event chunk, opened. */
  opened: OpenedChunk[];
}

/** Opens `body` with whichever identity it was sealed to. */
function openWithAny(body: Uint8Array, identities: readonly string[]): Buffer {
  for (const id of identities) {
    try {
      return openChunk(body, id);
    } catch {
      // Sealed to another identity; try the next.
    }
  }
  throw new Error('no identity held here opens it');
}

export async function readHosts(
  bucket: Pick<Bucket, 'list' | 'get'>,
  app: string,
  identities: readonly string[],
): Promise<HostReading[]> {
  const out: HostReading[] = [];
  for (const host of storeHosts(app)) {
    const listed = await bucket.list(`${host}/`);
    const counts: Record<string, number> = {};
    for (const o of listed) {
      const kind = o.key.split('/')[1] ?? '';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    const opened: OpenedChunk[] = [];
    for (const kind of ['transcripts', 'events']) {
      const last = listed.filter((o) => o.key.startsWith(`${host}/${kind}/`)).at(-1);
      if (!last) continue;
      const body = await bucket.get(last.key);
      const plain = openWithAny(body, identities);
      opened.push({
        key: last.key,
        sealedBytes: body.length,
        plainBytes: plain.length,
        lines: plain.toString('utf8').split('\n').filter(Boolean).length,
        sha256: createHash('sha256').update(plain).digest('hex'),
      });
    }
    out.push({ host, counts, opened });
  }
  return out;
}

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (line: string) => console.log(`[store-read] ${line}`);

async function main(): Promise<boolean> {
  const names = storeNames();
  const bucket = s3Bucket(readCredential({ keychainRead }, names.reader), names.bucket);
  const identities = Object.values(names.identities).map((n) => keychainRead(n).trim());
  switch (args[0]) {
    case 'list': {
      const app = arg('host');
      if (!app) throw new Error('--host <app> is required, e.g. --host cw-harborlight');
      const readings = await readHosts(bucket, app, identities);
      for (const r of readings) {
        const kinds = Object.entries(r.counts).map(([k, n]) => `${k} ${n}`);
        log(`${r.host}/: ${kinds.length ? kinds.join(', ') : 'no objects'}`);
        for (const o of r.opened) {
          log(
            `  opened ${o.key}: ${o.sealedBytes} bytes sealed, ${o.plainBytes} plain, ${o.lines} lines, sha256 ${o.sha256}`,
          );
        }
      }
      return readings.some((r) => r.opened.length > 0);
    }
    case 'check': {
      const day = arg('day') ?? utcDay(new Date(Date.now() - 86_400_000));
      const apps = (arg('hosts') ?? '').split(',').filter(Boolean);
      if (apps.length === 0) throw new Error('--hosts <app>[,<app>…] is required');
      const counts = await runCheck({
        bucket,
        hosts: apps.flatMap(storeHosts),
        day,
        identities,
        all: args.includes('--all'),
      });
      log(summary(day, counts));
      const r = await checkAndAlert(
        counts,
        day,
        process.env.CW_SENTRY_SERVER_DSN?.trim() || undefined,
      );
      for (const l of r.lines) log(l);
      log(r.failed ? `FAIL: ${r.raised} warnings raised` : 'PASS: nothing to raise');
      return !r.failed;
    }
    default:
      console.error('[store-read] usage: store:read list --host <app> | check --hosts <app,…>');
      process.exit(2);
  }
}

if (import.meta.main) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (err: unknown) => {
      console.error(`[store-read] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
