#!/usr/bin/env bun
/**
 * The restore drill, end to end, on a TEST project only.
 *
 *   bun run machine:drill --project <name>-test
 *
 * Seeds a drill board on the machine, fingerprints its docs, takes a backup
 * with the machine's own write-only credential, destroys the machine AND
 * its volume, recreates both with `machine:deploy`, restores the newest
 * snapshot with `machine:restore`, and fingerprints again. It passes only
 * when the two fingerprints match. Because it destroys the volume it refuses
 * any project whose name does not end in `-test`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { projectConfig } from './deploy-plan.ts';
import { deployProject, machines, tunnelAddress } from './deploy.ts';
import { flyJson, flyOk, onMachine } from './mac-ops.ts';
import { restoreMachine } from './restore-machine.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const PROBE = 'bun /app/infra/project-machine/drill-probe.ts';
const AS_CW = 'setpriv --reuid=cw --regid=cw --init-groups env HOME=/home/cw';

type Print = { count: number; sha256: string; ydocs: number };

/** The last JSON line of a command's output; `fly ssh` prints its own lines first. */
function lastJson<T>(out: string): T {
  const line = out
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`no JSON in: ${out.slice(-300)}`);
  return JSON.parse(line) as T;
}

async function waitForServer(app: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const code = onMachine(
      app,
      "curl -s -o /dev/null -w '%{http_code}' -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy || true",
    ).trim();
    if (/\d{3}$/.test(code) && !code.endsWith('000')) return;
    await Bun.sleep(2000);
  }
  throw new Error('the board server never answered on loopback');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const project = args[args.indexOf('--project') + 1];
  if (!project || !project.endsWith('-test')) {
    console.error('[drill] --project <name>-test is required: the drill destroys the volume');
    process.exit(2);
  }
  const sha = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const cfg = projectConfig({ project, imageLabel: sha });

  await deployProject(cfg, false);
  await waitForServer(cfg.app);
  console.log(`[drill] tunnel: ${(await tunnelAddress(cfg.app)) ?? 'not in the logs'}`);
  console.log(`[drill] seed: ${onMachine(cfg.app, `${PROBE} seed`).trim().split('\n').at(-1)}`);
  const before = lastJson<Print>(onMachine(cfg.app, `${PROBE} fingerprint`));
  console.log(`[drill] before: ${JSON.stringify(before)}`);
  if (before.count === 0) throw new Error('nothing to back up');
  const backup = onMachine(cfg.app, `${AS_CW} bun run /app/infra/project-machine/backup.ts`);
  console.log(`[drill] ${backup.trim().split('\n').at(-1)}`);

  for (const m of machines(cfg.app)) {
    flyOk(['machine', 'destroy', m.id, '--app', cfg.app, '--force']);
    console.log(`[drill] destroyed machine ${m.id}`);
  }
  for (const v of flyJson<{ id: string; name: string }[]>(['volumes', 'list', '--app', cfg.app])) {
    if (v.name !== cfg.volumeName) continue;
    flyOk(['volumes', 'destroy', v.id, '--app', cfg.app, '--yes']);
    console.log(`[drill] destroyed volume ${v.id}`);
  }

  await deployProject(cfg, false);
  await waitForServer(cfg.app);
  const empty = lastJson<Print>(onMachine(cfg.app, `${PROBE} fingerprint`));
  console.log(`[drill] fresh machine before restore: ${JSON.stringify(empty)}`);
  const key = await restoreMachine(cfg);
  await waitForServer(cfg.app);
  const after = lastJson<Print>(onMachine(cfg.app, `${PROBE} fingerprint`));
  console.log(`[drill] restored ${key}`);
  console.log(`[drill] after: ${JSON.stringify(after)}`);
  const ok = after.count === before.count && after.sha256 === before.sha256;
  console.log(`[drill] ${ok ? 'PASS' : 'FAIL'}: docs ${before.count} -> ${after.count}`);
  if (!ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`[drill] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
