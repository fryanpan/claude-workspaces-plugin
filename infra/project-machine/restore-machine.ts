#!/usr/bin/env bun
/**
 * Put a project's newest snapshot (or a named one) back onto its machine.
 *
 *   bun run machine:restore --project <name> [--snapshot <key>]
 *
 * The decrypt happens on the Mac, so the identity never goes near the
 * machine: download with the bucket's admin credential, restore into a
 * private temp dir with `restoreSnapshot`, pack it, and copy it up. On the
 * machine the services are held off with `/data/maintenance`, the current
 * data dir is moved aside (never deleted) to `/data/cw.before-restore-<stamp>`,
 * and the restored one takes its place. The steps are the runbook's
 * "Restoring the machine itself", docs/process/project-machine.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProjectConfig, newestSnapshot, projectConfig } from './deploy-plan.ts';
import { bucketAdmin, machines } from './deploy.ts';
import { flyOk, keychainRead, onMachine } from './mac-ops.ts';
import { restoreSnapshot } from './snapshot.ts';

const ZERO_SHA = '0'.repeat(40);

async function waitStarted(cfg: ProjectConfig, id: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (machines(cfg.app).find((m) => m.id === id)?.state === 'started') return;
    await Bun.sleep(2000);
  }
  throw new Error(`machine ${id} did not start`);
}

export async function restoreMachine(cfg: ProjectConfig, snapshotKey?: string): Promise<string> {
  const admin = bucketAdmin(cfg);
  const client = new Bun.S3Client({ ...admin, bucket: cfg.bucket, region: 'auto' });
  let key = snapshotKey;
  if (!key) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.list({ prefix: 'snapshots/', continuationToken: token });
      for (const o of page.contents ?? []) keys.push(o.key);
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    key = newestSnapshot(keys) ?? undefined;
  }
  if (!key) throw new Error(`no snapshot in ${cfg.bucket}`);
  const machine = machines(cfg.app).find((m) => m.state !== 'destroyed');
  if (!machine) throw new Error(`${cfg.app} has no machine; run machine:deploy first`);

  const work = mkdtempSync(join(tmpdir(), `${cfg.app}-restore-`));
  try {
    const snap = join(work, 'snapshot.cwsnap');
    await Bun.write(snap, client.file(key));
    const data = join(work, 'data');
    restoreSnapshot(snap, keychainRead(cfg.keychain.identity), data);
    const tgz = join(work, 'restored.tgz');
    const tar = spawnSync('tar', ['-czf', tgz, '-C', data, '.'], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('tar failed');

    console.log(`[restore] ${key} -> ${machine.id}: holding services off`);
    onMachine(cfg.app, 'touch /data/maintenance');
    flyOk(['machine', 'restart', machine.id, '--app', cfg.app]);
    await waitStarted(cfg, machine.id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    onMachine(cfg.app, `if [ -e /data/cw ]; then mv /data/cw /data/cw.before-restore-${stamp}; fi`);
    flyOk(['ssh', 'sftp', 'put', tgz, '/data/restored.tgz', '--app', cfg.app]);
    onMachine(
      cfg.app,
      'mkdir /data/cw && tar -xzf /data/restored.tgz -C /data/cw && chown -R cw:cw /data/cw && rm /data/restored.tgz /data/maintenance',
    );
    flyOk(['machine', 'restart', machine.id, '--app', cfg.app]);
    await waitStarted(cfg, machine.id);
    console.log(`[restore] done; the previous data dir is /data/cw.before-restore-${stamp}`);
    return key;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const project = at('project');
  if (!project) {
    console.error('[restore] --project <name> is required');
    process.exit(2);
  }
  // The image label plays no part in a restore.
  restoreMachine(projectConfig({ project, imageLabel: ZERO_SHA }), at('snapshot')).catch(
    (err: unknown) => {
      console.error(`[restore] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
