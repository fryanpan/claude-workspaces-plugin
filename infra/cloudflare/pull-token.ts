#!/usr/bin/env bun
/**
 * `bun run cf:pull-token ["<name>"]`: what prod does every 15 minutes
 * (`packages/server/src/token-drop/token-drop-start.ts`), once, by hand:
 * open the sealed drop CI wrote for one token (or every token) and store the
 * new pair in the Keychain over the old one. For when prod is down, or to see
 * why a drop was not taken. CW_DATA_DIR names prod's data dir, where the
 * record of which rotations were stored lives; without it nothing is pulled.
 *
 * It prints which tokens it stored or refused, and never a value.
 */
import { spawnCommand } from '../../packages/server/src/secret-store.ts';
import { pullDrops } from '../../packages/server/src/token-drop/token-drop-pull.ts';
import { bucketConfig, pullIo } from '../../packages/server/src/token-drop/token-drop-start.ts';

const name = process.argv[2];
const dataDir = process.env.CW_DATA_DIR?.trim();
const say = (s: string) => process.stderr.write(`[cf:pull-token] ${s}\n`);
if (!dataDir) {
  say("set CW_DATA_DIR to prod's data dir; nothing was pulled");
  process.exit(2);
}
const cfg = await bucketConfig(spawnCommand, process.env);
if (!cfg.ok) {
  say(`not pulling: ${cfg.missing}`);
  process.exit(1);
}
const { ok: _ok, ...c } = cfg;
const results = await pullDrops(
  pullIo(spawnCommand, new Bun.S3Client({ ...c, region: 'auto' }), dataDir, say),
  name,
);
if (results === null) {
  say('the Keychain holds no drop private key yet; prod makes one at boot');
  process.exit(1);
}
if (results.length === 0) say('no drops in the bucket');
process.exit(
  results.every((r) => r.outcome === 'stored' || r.outcome === 'already-stored') ? 0 : 1,
);
