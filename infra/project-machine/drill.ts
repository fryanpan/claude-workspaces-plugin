#!/usr/bin/env bun
/**
 * The restore drill, end to end, on a TEST project only.
 *
 *   bun run machine:drill --project <name>-test
 *
 * Seeds a drill board on the machine (two docs, a task, an agent note and a
 * session transcript), counts and hashes its docs, events, notes and
 * transcripts, takes a backup with the machine's own write-only credential,
 * destroys the machine AND its volume, recreates both with `machine:deploy`,
 * restores the newest snapshot with `machine:restore`, and counts and hashes
 * again. It passes only when all four match (`judgeDrill`). Because it destroys the volume it refuses
 * any project whose name does not end in `-test`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { type DrillPrint, drillLimits, judgeDrill, projectConfig } from './deploy-plan.ts';
import { deployProject, machines, tunnelAddress } from './deploy.ts';
import { flyJson, flyOk, onMachine } from './mac-ops.ts';
import { restoreMachine } from './restore-machine.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const PROBE = 'bun /app/infra/project-machine/drill-probe.ts';

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

function summary(p: DrillPrint): string {
  const log = (l: DrillPrint['events']) => `${l.files} file(s) ${l.lines} line(s)`;
  return `docs ${p.count} (${p.sha256.slice(0, 12)}), events ${log(p.events)}, notes ${log(p.notes)}, transcripts ${log(p.transcripts)}`;
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
  const at = args.indexOf('--project');
  const project = at >= 0 ? args[at + 1] : undefined;
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
  const before = lastJson<DrillPrint>(onMachine(cfg.app, `${PROBE} fingerprint`));
  console.log(`[drill] before: ${summary(before)}`);
  if (before.count === 0) throw new Error('nothing to back up');
  const backup = onMachine(cfg.app, 'bash /app/infra/project-machine/backup-once.sh');
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
  const empty = lastJson<DrillPrint>(onMachine(cfg.app, `${PROBE} fingerprint`));
  console.log(`[drill] fresh machine before restore: ${summary(empty)}`);
  const key = await restoreMachine(cfg);
  await waitForServer(cfg.app);
  const limits = Buffer.from(JSON.stringify(drillLimits(before))).toString('base64');
  const after = lastJson<DrillPrint>(onMachine(cfg.app, `${PROBE} fingerprint ${limits}`));
  console.log(`[drill] restored ${key}`);
  console.log(`[drill] after: ${summary(after)}`);
  const { ok, lines } = judgeDrill(before, after);
  for (const l of lines) console.log(`[drill] ${l}`);
  console.log(`[drill] ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`[drill] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
