#!/usr/bin/env bun
/**
 * `bun run handoff:pull`: take what CI sealed to the Mac and store it.
 *
 * For each workflow that hands off (`WORKFLOWS`), the finished runs on main
 * that a push, a schedule or a dispatch started in this repository
 * (`TRUSTED_EVENTS`) and this Mac has not pulled yet, oldest first, so a rotated secret lands after
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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
/**
 * The usual name of a sealed file in the artifact (`HandoffSink`'s output).
 * A run with two steps that hand off writes two (fly-provision.yml's deploy
 * and its token apply), and every `.json` file in the artifact is read.
 */
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
  /** The file names in a folder. */
  listFiles: (dir: string) => string[];
  remove: (p: string) => void;
  store: (item: HandoffItem) => 'stored' | 'kept';
  err: (s: string) => void;
}

/**
 * The events a run may start from and still be trusted to have run main's
 * own workflow file. A pull request's run executes the workflow as the pull
 * request edited it, and a fork's head branch may be named `main`; the
 * envelope carries no sender, so such a run could hand the Mac anything
 * sealed to its public key. server-release.yml makes the same check.
 */
export const TRUSTED_EVENTS: ReadonlySet<string> = new Set([
  'push',
  'schedule',
  'workflow_dispatch',
]);

interface RunRow {
  id?: unknown;
  created_at?: unknown;
  event?: unknown;
  head_branch?: unknown;
  head_repository?: { full_name?: unknown } | null;
}

/** A workflow's finished runs on main that a trusted event started here (`TRUSTED_EVENTS`). */
export function listRuns(gh: PullIo['gh'], workflow: string): { id: string; at: string }[] {
  // The REST list, not `gh run list`: only it names the head repository.
  const r = gh([
    'api',
    '-X',
    'GET',
    `repos/${HANDOFF_REPO}/actions/workflows/${workflow}/runs`,
    '-f',
    'branch=main',
    // Finished, not only successful: a provisioning run that failed part way
    // still sealed what it made before it stopped.
    '-f',
    'status=completed',
    '-f',
    'per_page=20',
  ]);
  if (r.status !== 0) throw new Error(`listing ${workflow} runs failed: ${r.stderr.trim()}`);
  const body = JSON.parse(r.stdout || '{}') as { workflow_runs?: RunRow[] };
  return (body.workflow_runs ?? [])
    .filter(
      (x) =>
        (typeof x.id === 'number' || typeof x.id === 'string') &&
        typeof x.event === 'string' &&
        TRUSTED_EVENTS.has(x.event) &&
        x.head_branch === 'main' &&
        x.head_repository?.full_name === HANDOFF_REPO,
    )
    .map((x) => ({ id: String(x.id), at: String(x.created_at ?? '') }));
}

/**
 * gh's own words for a run with no `handoff-mac` artifact: the run has none
 * at all, or none by that name. Matched whole, so an unrelated 404 (a run
 * that is gone, a lost login) is a failure to retry, not a run marked pulled.
 */
const NO_ARTIFACT = [
  'no valid artifacts found to download',
  'no artifact matches any of the names or patterns provided',
];

export function noArtifact(stderr: string): boolean {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .some((l) => NO_ARTIFACT.includes(l));
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
      for (const r of listRuns(io.gh, workflow)) if (!seen.has(r.id)) runs.push({ ...r, workflow });
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
        if (noArtifact(d.stderr)) {
          seen.add(run.id);
          continue;
        }
        say(`${run.workflow} run ${run.id}: gh run download failed: ${d.stderr.trim()}`);
        failed = true;
        continue;
      }
      const names = io
        .listFiles(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      if (names.length === 0) throw new Error('the artifact holds no sealed file');
      for (const name of names) {
        const opened = openItems(key, io.readFile(join(dir, name)));
        if (opened.recipient !== 'mac')
          throw new Error(`sealed to ${opened.recipient}, not this Mac`);
        for (const item of opened.items) {
          if (item.kind === 'fly-secrets') throw new Error('a fly-secrets item is not for the Mac');
          const r = io.store(item);
          say(
            `${run.workflow} run ${run.id}: ${describeItem(item)} ${r === 'stored' ? 'stored' : 'kept the newer one already here'}`,
          );
        }
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
    listFiles: (d) => readdirSync(d),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    store: await realStore(dir),
    err: (s) => process.stderr.write(s),
  };
}

if (import.meta.main) {
  process.exit(pull(await realPullIo()));
}
