#!/usr/bin/env bun
/**
 * Build the MCP children.
 *
 *   packages/mcp/dist/mcp.js        — the full stdio child, bundled from
 *                                     src/mcp.ts: the `bin` target of the
 *                                     npm package (`claude-workspaces-mcp`).
 *                                     Gitignored.
 *
 *   packages/plugin/mcp/relay.js    — the node relay, committed into the
 *                                     plugin tree; `.mcp.json` runs it
 *                                     through bin/claude-workspaces-mcp.sh.
 *
 * The plugin no longer ships the full child. It used to be written to
 * packages/plugin/mcp/index.js as the rollback behind CW_MCP_RELAY=0; its
 * last release is the git tag mcp-full-child-rollback. Sessions reach the
 * same tool code through the server's hosted connector at /mcp.
 *
 * Usage:  bun run packages/mcp/scripts/build.ts
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const srcEntry = join(pkgRoot, 'src', 'mcp.ts');

const distOutFile = join(pkgRoot, 'dist', 'mcp.js');
const relayFile = join(repoRoot, 'packages', 'plugin', 'mcp', 'relay.js');

mkdirSync(dirname(distOutFile), { recursive: true });
mkdirSync(dirname(relayFile), { recursive: true });

const result = await Bun.build({
  entrypoints: [srcEntry],
  target: 'node',
  format: 'esm',
  minify: false,
});

if (!result.success || result.outputs.length === 0) {
  console.error(result.logs.join('\n'));
  throw new Error('mcp build failed');
}
const out = result.outputs[0];
if (!out) throw new Error('mcp build produced no output');
const code = await out.text();

// Re-prepend the shebang (Bun.build strips the one in source because it's a
// source-comment). Needed so the file can be exec'd directly.
const finalCode = `#!/usr/bin/env node\n${code.replace(/^#!.*\n/, '')}`;

await Bun.write(distOutFile, finalCode);
chmodSync(distOutFile, 0o755);
console.log(`[mcp] built → ${distOutFile}`);

// The node relay (src/relay/): the child the launcher runs when the compiled
// relay is not built yet or cannot be. A bundle of its own, so a relay
// session loads a few hundred lines rather than every tool handler and the SDK.
const relayResult = await Bun.build({
  entrypoints: [join(pkgRoot, 'src', 'relay', 'main.ts')],
  target: 'node',
  format: 'esm',
  minify: false,
});
const relayOut = relayResult.outputs[0];
if (!relayResult.success || !relayOut) {
  console.error(relayResult.logs.join('\n'));
  throw new Error('relay build failed');
}
await Bun.write(
  relayFile,
  `#!/usr/bin/env node\n${(await relayOut.text()).replace(/^#!.*\n/, '')}`,
);
chmodSync(relayFile, 0o755);
console.log(`[mcp] built → ${relayFile}`);
