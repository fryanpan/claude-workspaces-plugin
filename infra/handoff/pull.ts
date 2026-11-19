#!/usr/bin/env bun
/**
 * `bun run handoff:pull`: take what CI sealed to the Mac and store it.
 *
 * For each workflow that hands off (`WORKFLOWS`), the successful runs on main
 * this Mac has not pulled yet, oldest first, so a rotated secret lands after
 * the one it replaces. `gh run download` fetches the run's `handoff-mac`
 * artifact with Bryan's own `gh` login; the artifact is public in a public
 * repository, which is why it is sealed. Each item is stored (`storeItem`):
 *
 *   keychain        a new Keychain entry; an existing one is never replaced
 *   service-token   the pair under the token's services; replaced only for a
 *                   rotation
 *   fly-app-token   `fly-tokens/<app>.json` in the handoff folder, when it
 *                   lasts longer than the one there
 *
 * A run with no artifact handed nothing to this Mac and is marked pulled. A
 * run whose download or store failed is not, so the next pull tries again
 * until the artifact expires. Nothing pulled is printed: lines name an item's
 * kind and target only.
 *
 * `mac-ops.ts` runs this itself when it needs an app's token and has none.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HandoffItem, describeItem, openItems } from './items.ts';
import {
  HANDOFF_REPO,
  handoffDir,
  readPrivateKey,
  readSeen,
  storeAppToken,
  writeSeen,
} from './mac-store.ts';

/** The workflows whose runs on main may carry a `handoff-mac` artifact. */
export const WORKFLOWS = [
  'fly-ci-tokens.yml',
  'fly-provision.yml',
  'cloudflare.yml',
  'cf-rotate-token.yml',
] as const;
export const MAC_ARTIFACT = 'handoff-mac';
/** The file the artifact holds (`HandoffSink`'s output). */
export const HANDOFF_FILE = 'handoff.json';

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

export interface PullIo {
  gh: (args: string[]) => Run;
  privateKey: () => string;
  seen: () => Set<string>;
  saveSeen: (s: Set<string>) => void;
  /** A fresh folder for one download. */
  tempDir: () => string;
  readFile: (p: string) => string;
  remove: (p: string) => void;
  store: (item: HandoffItem) => 'stored' | 'kept';
  err: (s: string) => void;
}

interface RunRow {
  databaseId?: unknown;
  createdAt?: unknown;
}

function listRuns(io: PullIo, workflow: string): { id: string; at: string }[] {
  const r = io.gh([
    'run',
    'list',
    '--repo',
    HANDOFF_REPO,
    '--workflow',
    workflow,
    '--branch',
    'main',
    '--status',
    'success',
    '--limit',
    '20',
    '--json',
    'databaseId,createdAt',
  ]);
  if (r.status !== 0)
    throw new Error(`gh run list --workflow ${workflow} failed: ${r.stderr.trim()}`);
  const rows = JSON.parse(r.stdout || '[]') as RunRow[];
  return rows
    .filter((x) => typeof x.databaseId === 'number' || typeof x.databaseId === 'string')
    .map((x) => ({ id: String(x.databaseId), at: String(x.createdAt ?? '') }));
}

/** Exit code: 0 when every new run was pulled, 1 when one failed. */
export function pull(io: PullIo): number {
  const say = (s: string) => io.err(`[handoff:pull] ${s}\n`);
  let key: string;
  try {
    key = io.privateKey();
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const seen = io.seen();
  const runs: { id: string; at: string; workflow: string }[] = [];
  let failed = false;
  for (const workflow of WORKFLOWS) {
    try {
      for (const r of listRuns(io, workflow)) if (!seen.has(r.id)) runs.push({ ...r, workflow });
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      failed = true;
    }
  }
  runs.sort((a, b) => a.at.localeCompare(b.at));
  for (const run of runs) {
    const dir = io.tempDir();
    try {
      const d = io.gh([
        'run',
        'download',
        run.id,
        '--repo',
        HANDOFF_REPO,
        '--name',
        MAC_ARTIFACT,
        '--dir',
        dir,
      ]);
      if (d.status !== 0) {
        if (/no (valid )?artifacts? (found|matches)|not found/i.test(d.stderr)) {
          seen.add(run.id);
          continue;
        }
        say(`${run.workflow} run ${run.id}: gh run download failed: ${d.stderr.trim()}`);
        failed = true;
        continue;
      }
      const opened = openItems(key, io.readFile(join(dir, HANDOFF_FILE)));
      if (opened.recipient !== 'mac')
        throw new Error(`sealed to ${opened.recipient}, not this Mac`);
      for (const item of opened.items) {
        if (item.kind === 'fly-secrets') throw new Error('a fly-secrets item is not for the Mac');
        const r = io.store(item);
        say(
          `${run.workflow} run ${run.id}: ${describeItem(item)} ${r === 'stored' ? 'stored' : 'kept the newer one already here'}`,
        );
      }
      seen.add(run.id);
    } catch (e) {
      say(`${run.workflow} run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
    } finally {
      io.remove(dir);
    }
  }
  io.saveSeen(seen);
  if (runs.length === 0) say('nothing new');
  return failed ? 1 : 0;
}

/** The real store: the Keychain for credentials, the handoff folder for Fly tokens. */
export async function realStore(dir: string): Promise<PullIo['store']> {
  const { keychainCreate, keychainHas } = await import('../project-machine/mac-ops.ts');
  const { replaceTokenInKeychain, storeTokenInKeychain, tokenServices } = await import(
    '../cloudflare/service-tokens.ts'
  );
  return (item) => {
    switch (item.kind) {
      case 'keychain':
        if (keychainHas(item.name)) return 'kept';
        keychainCreate(item.name, item.value);
        return 'stored';
      case 'service-token': {
        const s = tokenServices(item.name);
        (item.replace ? replaceTokenInKeychain : storeTokenInKeychain)(
          s,
          item.clientId,
          item.secret,
        );
        return 'stored';
      }
      case 'fly-app-token':
        return storeAppToken(dir, item.app, { token: item.token, notAfter: item.notAfter })
          ? 'stored'
          : 'kept';
      case 'fly-secrets':
        throw new Error('a fly-secrets item is not for the Mac');
    }
  };
}

export async function realPullIo(): Promise<PullIo> {
  const dir = handoffDir();
  return {
    gh: (args) => {
      const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    privateKey: () => readPrivateKey(dir),
    seen: () => readSeen(dir),
    saveSeen: (s) => writeSeen(dir, s),
    tempDir: () => mkdtempSync(join(tmpdir(), 'cw-handoff-')),
    readFile: (p) => readFileSync(p, 'utf8'),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    store: await realStore(dir),
    err: (s) => process.stderr.write(s),
  };
}

if (import.meta.main) {
  process.exit(pull(await realPullIo()));
}
