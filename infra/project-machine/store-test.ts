#!/usr/bin/env bun
/**
 * The transcript store's first step, proved in a test bucket, from the Mac.
 *
 *   bun run store:test setup [--dry-run]        bucket, versioning, keys, both credentials
 *   bun run store:test prove                    steps 1-3
 *   bun run store:test drill --day <YYYY-MM-DD> step 4: stage a day with four faults
 *   bun run store:test check --day <YYYY-MM-DD> [--hosts a,b] [--all]
 *                                               step 4: the daily check, raising to Sentry
 *   bun run store:test time [--interval 60] [--poll 5] [--timeout 900]
 *                                               step 5: event to analysis
 *   bun run store:test ratio --file <path> [--seconds 60]
 *                                               step 5: zstd ratio of one minute of a file
 *
 * Every command takes `--bucket <name>-test` (default `cw-store-test`) and
 * refuses any other bucket. Credentials and identities come out of the
 * Keychain and stay in memory; nothing printed holds a value. The check
 * raises to the DSN in `CW_SENTRY_SERVER_DSN`, the server's own, and without
 * one says what it would have raised. Each command exits 1 when it fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseStorageCreate } from './deploy-plan.ts';
import { fly, keychainCreate, keychainHas, keychainRead } from './mac-ops.ts';
import { checkAndAlert, runCheck, summary } from './store-check.ts';
import { stageDrill } from './store-drill.ts';
import { proveStore } from './store-prove.ts';
import { s3Bucket } from './store-s3.ts';
import {
  FLY_HOST,
  type SetupOps,
  readCredential,
  setupStoreTest,
  storeTestNames,
} from './store-setup.ts';
import { sampleRatio, timeEvent } from './store-time.ts';
import { utcDay } from './store-upload.ts';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name) ?? fallback);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
  return v;
};
const log = (line: string) => console.log(`[store-test] ${line}`);

const ops: SetupOps = {
  keychainHas,
  keychainRead,
  keychainCreate,
  createBucket: async (name) => {
    const org = keychainRead('fly-org-slug').trim();
    // Not flyOk: the output holds the admin credential, so only stderr is shown on failure.
    const r = fly(['storage', 'create', '--org', org, '--name', name, '--yes']);
    if (r.status !== 0) throw new Error(`fly storage create failed: ${r.stderr.trim()}`);
    return parseStorageCreate(r.stdout);
  },
};

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-store-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<boolean> {
  const names = storeTestNames(arg('bucket') ?? 'cw-store-test');
  switch (args[0]) {
    case 'setup': {
      const dry = args.includes('--dry-run');
      const done = await setupStoreTest(names, ops, dry);
      if (done.length === 0) log(`${names.bucket}: nothing to do`);
      for (const d of done) log(`${dry ? 'would ' : ''}${d}`);
      return true;
    }
    case 'prove':
      return withScratch((dir) => proveStore(names, ops, dir, log));
    case 'drill': {
      const day = arg('day');
      if (!day) throw new Error('--day <YYYY-MM-DD> is required');
      await withScratch((dir) => stageDrill(names, ops, dir, day, {}, log));
      log(`now run: bun run store:test check --day ${day}`);
      return true;
    }
    case 'check': {
      const day = arg('day') ?? utcDay(new Date(Date.now() - 86_400_000));
      const hosts = (arg('hosts') ?? FLY_HOST).split(',').filter(Boolean);
      const counts = await runCheck({
        bucket: s3Bucket(readCredential(ops, names.reader), names.bucket),
        hosts,
        day,
        identities: Object.values(names.identities).map((n) => keychainRead(n).trim()),
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
    case 'time': {
      const r = await withScratch((dir) =>
        timeEvent(
          names,
          ops,
          dir,
          {
            intervalS: num('interval', 60),
            pollS: num('poll', 5),
            timeoutS: num('timeout', 900),
            phase: Math.random(),
          },
          log,
        ),
      );
      return r.writeToVisibleS !== null && r.writeToVisibleS <= 300;
    }
    case 'ratio': {
      const file = arg('file');
      if (!file) throw new Error('--file <path> is required');
      const seconds = num('seconds', 60);
      const r = await sampleRatio(resolve(file), seconds);
      log(
        `one ${seconds} s chunk: ${r.raw} bytes raw, ${r.compressed} after zstd -3, ratio ${r.ratio}`,
      );
      return true;
    }
    default:
      console.error(
        '[store-test] usage: store:test setup|prove|drill|check|time|ratio [--bucket <name>-test]',
      );
      process.exit(2);
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err: unknown) => {
    console.error(`[store-test] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
