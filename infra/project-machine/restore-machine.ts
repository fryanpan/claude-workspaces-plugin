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
 * data dir and transcripts dir are moved aside (never deleted) to
 * `<dir>.before-restore-<stamp>`, and the restored ones take their place. The steps are the runbook's
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
/** Where the machine keeps them: fly.toml's CW_DATA_DIR and BACKUP_TRANSCRIPTS_DIR. */
const MACHINE_DATA_DIR = '/data/cw';
const MACHINE_TRANSCRIPTS_DIR = '/data/claude-projects';

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
    const local = { data: join(work, 'data'), transcripts: join(work, 'transcripts') };
    const r = restoreSnapshot(
      snap,
      keychainRead(cfg.keychain.identity),
      local.data,
      local.transcripts,
    );
    const parts = [{ from: local.data, to: MACHINE_DATA_DIR, tgz: join(work, 'data.tgz') }];
    if (r.transcripts) {
      parts.push({
        from: local.transcripts,
        to: MACHINE_TRANSCRIPTS_DIR,
        tgz: join(work, 'transcripts.tgz'),
      });
    }
    for (const p of parts) {
      // macOS tar otherwise adds an AppleDouble `._<name>` file beside each
      // file with extended attributes, and the server reads those as docs.
      const tar = spawnSync(
        'tar',
        ['--no-mac-metadata', '--no-xattrs', '-czf', p.tgz, '-C', p.from, '.'],
        {
          stdio: 'inherit',
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        },
      );
      if (tar.status !== 0) throw new Error('tar failed');
    }

    console.log(`[restore] ${key} -> ${machine.id}: holding services off`);
    onMachine(cfg.app, 'touch /data/maintenance');
    flyOk(['machine', 'restart', machine.id, '--app', cfg.app]);
    await waitStarted(cfg, machine.id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const p of parts) {
      const upload = `${p.to}.restored.tgz`;
      onMachine(cfg.app, `if [ -e ${p.to} ]; then mv ${p.to} ${p.to}.before-restore-${stamp}; fi`);
      flyOk(['ssh', 'sftp', 'put', p.tgz, upload, '--app', cfg.app]);
      onMachine(
        cfg.app,
        `mkdir ${p.to} && tar -xzf ${upload} -C ${p.to} && chown -R cw:cw ${p.to} && rm ${upload}`,
      );
    }
    onMachine(cfg.app, 'rm /data/maintenance');
    flyOk(['machine', 'restart', machine.id, '--app', cfg.app]);
    await waitStarted(cfg, machine.id);
    const moved = parts.map((p) => `${p.to}.before-restore-${stamp}`).join(', ');
    console.log(`[restore] done (${parts.length} part(s)); the previous copies are ${moved}`);
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
