#!/usr/bin/env bun
/**
 * The MCP bundle-drift gate.
 *
 * Sessions load `packages/plugin/mcp/relay.js`, the node relay, not the
 * TypeScript under `packages/mcp/src/relay`. An edit to the source that never
 * reaches the committed bundle ships nothing, and the session that loads it
 * reports success — which is the failure mode this gate exists for. (The
 * full child, `packages/plugin/mcp/index.js`, is no longer shipped; its last
 * release is the git tag mcp-full-child-rollback.)
 *
 * The check is a rebuild plus a diff: build the bundle from today's source and
 * fail if the tracked artifact moved. It does NOT revert the rebuild. The fix
 * is to commit what the build produced, so leaving it in the working tree is
 * the fix already half-applied; reverting would hide it.
 *
 * This used to be eight lines of inline shell in .github/workflows/ci.yml. It
 * is a script so that CI and `bun run verify` run the SAME check rather than
 * two hand-copied versions of it.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The node relay, built by `bun run build:mcp` (packages/mcp/src/relay/). */
export const RELAY_BUNDLE = 'packages/plugin/mcp/relay.js';

/** GitHub renders `::error::` as an annotation; a terminal renders it as noise. */
function fail(message: string): void {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `❌ ${message}`);
}

const built = Bun.spawnSync(['bun', 'run', 'build:mcp'], {
  cwd: REPO_ROOT,
  stdio: ['inherit', 'inherit', 'inherit'],
});
if (built.exitCode !== 0) {
  fail('bun run build:mcp failed — the bundle could not be rebuilt, so drift is unknown.');
  process.exit(built.exitCode ?? 1);
}

const diff = Bun.spawnSync(['git', 'diff', '--quiet', '--', RELAY_BUNDLE], { cwd: REPO_ROOT });
if (diff.exitCode === 0) {
  console.log(`✓ ${RELAY_BUNDLE} matches a fresh build.`);
  process.exit(0);
}

fail(`${RELAY_BUNDLE} is stale — it does not match a fresh build of packages/mcp/src/relay.`);
console.error('Sessions load the committed bundle, not the TypeScript source, so an unrebuilt');
console.error('bundle ships nothing. The rebuild has already been written to your working');
console.error(`tree — commit it:  git add ${RELAY_BUNDLE}`);
const stat = Bun.spawnSync(['git', 'diff', '--stat', '--', RELAY_BUNDLE], { cwd: REPO_ROOT });
console.error(stat.stdout.toString());
process.exit(1);
