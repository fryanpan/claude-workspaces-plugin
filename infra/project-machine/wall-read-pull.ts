/**
 * The Mac's side of the wall read (`wall-read.ts`): download the newest
 * sealed read CI made, open it with the Mac's handoff key, and say how old it
 * is. `gh` with the owner's own login downloads it; no Cloudflare or Fly
 * credential is read here, and nothing here runs `security`.
 *
 * Only runs `pull.ts` trusts are read: finished, on main, in this repository,
 * started by a push, a schedule or a dispatch. An envelope carries no sender,
 * so a pull request's run could seal anything to the Mac's public key.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_REPO, handoffDir, readPrivateKey } from '../handoff/mac-store.ts';
import { type PullIo, listRuns, noArtifact } from '../handoff/pull.ts';
import type { Row } from './wall-drift.ts';
import {
  type CloudflareRead,
  type FlyRead,
  WALL_READ_WORKFLOW,
  type WallReadPart,
  artifactFor,
  openWallRead,
} from './wall-read.ts';

/** A read older than this fails its row: the workflow runs daily, so this allows one late run. */
export const MAX_AGE_MS = 36 * 3_600_000;
/** How many of the newest runs are tried for a part's artifact. */
const RUNS_TRIED = 5;

export interface WallReadPullIo {
  gh: PullIo['gh'];
  privateKey: () => string;
  tempDir: () => string;
  readFile: (p: string) => string;
  listFiles: (dir: string) => string[];
  remove: (p: string) => void;
}

export interface Pulled<T> {
  read: T;
  runId: string;
}

export const DISPATCH_HINT = `gh workflow run ${WALL_READ_WORKFLOW} --ref main`;

/** The newest trusted run's read of `part`; throws naming what failed. */
export function pullWallRead(io: WallReadPullIo, part: 'cloudflare'): Pulled<CloudflareRead>;
export function pullWallRead(io: WallReadPullIo, part: 'fly'): Pulled<FlyRead>;
export function pullWallRead(
  io: WallReadPullIo,
  part: WallReadPart,
): Pulled<CloudflareRead | FlyRead> {
  const key = io.privateKey();
  const runs = listRuns(io.gh, WALL_READ_WORKFLOW)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RUNS_TRIED);
  const failures: string[] = [];
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
        artifactFor(part),
        '--dir',
        dir,
      ]);
      if (d.status !== 0) {
        if (!noArtifact(d.stderr)) failures.push(`run ${run.id}: gh run download failed`);
        continue;
      }
      const files = io.listFiles(dir).filter((f) => f.endsWith('.json'));
      if (files.length !== 1) {
        failures.push(`run ${run.id}: ${files.length} sealed files, not one`);
        continue;
      }
      const text = io.readFile(join(dir, files[0] as string));
      const read =
        part === 'fly' ? openWallRead(key, text, 'fly') : openWallRead(key, text, 'cloudflare');
      return { read, runId: run.id };
    } catch (e) {
      failures.push(`run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      io.remove(dir);
    }
  }
  throw new Error(
    `no ${WALL_READ_WORKFLOW} run on main holds a readable ${artifactFor(part)}${failures.length ? ` (${failures.join('; ')})` : ''}: ${DISPATCH_HINT}`,
  );
}

/** One row per part: which run it came from and whether it is fresh enough to judge by. */
export function ciReadRow(
  part: WallReadPart,
  pulled: Pulled<{ readAt: number }> | Error,
  now: number,
): Row {
  const check = `CI read of ${part === 'fly' ? 'fly apps list' : 'Cloudflare'}`;
  if (pulled instanceof Error)
    return { project: '(all)', check, answer: pulled.message, ok: false };
  const age = now - pulled.read.readAt;
  const hours = Math.max(0, Math.round(age / 3_600_000));
  const ok = age <= MAX_AGE_MS && age > -300_000;
  return {
    project: '(all)',
    check,
    answer: `run ${pulled.runId}, ${hours}h old${ok ? '' : `; older than ${MAX_AGE_MS / 3_600_000}h or from the future: ${DISPATCH_HINT}`}`,
    ok,
  };
}

export function realWallReadPullIo(): WallReadPullIo {
  return {
    gh: (args) => {
      const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    privateKey: () => readPrivateKey(handoffDir()),
    tempDir: () => mkdtempSync(join(tmpdir(), 'cw-wall-read-')),
    readFile: (p) => readFileSync(p, 'utf8'),
    listFiles: (d) => readdirSync(d),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
  };
}
