import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The plugin's MCP server has to start from sessions that were not launched by
 * an interactive shell — launchd, a GUI app, cron. `"command": "node"` did not:
 * on a machine where node comes from nvm, PATH is built in ~/.zshrc, so `node`
 * resolves interactively and nowhere else. Those sessions got a bare ENOENT and
 * no workspace tools at all.
 *
 * These tests run the launcher with a PATH that deliberately has no node on it.
 */

const REPO = resolve(__dirname, '../../..');
const LAUNCHER = resolve(REPO, 'packages/plugin/bin/claude-workspaces-mcp.sh');
/** The node relay: what `.mcp.json` passes the launcher, and the child it runs without a compiled relay. */
const RELAY = resolve(REPO, 'packages/plugin/mcp/relay.js');
/** The full stdio child's old bundle. The plugin stopped shipping it. */
const OLD_BUNDLE = resolve(REPO, 'packages/plugin/mcp/index.js');
/** The git tag on the last commit that shipped the full child. */
const ROLLBACK_TAG = 'mcp-full-child-rollback';
const MCP_JSON = resolve(REPO, 'packages/plugin/.mcp.json');

/** A PATH with the usual system dirs and no node — what launchd hands a process. */
const NODELESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function run(
  command: string,
  args: string[],
  {
    stdin,
    timeoutMs = 20_000,
    env = { PATH: NODELESS_PATH, HOME: process.env.HOME ?? '' },
    holdStdin = false,
  }: {
    stdin?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /** Keep stdin open, as a session does. The node relay under bun can see
     *  the EOF before it answers, and a session never sends one. */
    holdStdin?: boolean;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const done = (code: number | null) => resolvePromise({ code, stdout, stderr });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      // The server stays alive after answering; stop as soon as it has framed a reply.
      if (stdout.includes('\n')) child.kill();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
      done(null);
    });
    child.on('close', done);

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => clearTimeout(timer));

    // A launcher that refuses to start exits before it reads stdin, so the
    // write can fail with EPIPE. That is the outcome under test, not an error;
    // unhandled, it fails the whole vitest run (CI, PR 1820).
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.write(stdin);
    if (!holdStdin) child.stdin.end();
  });
}

/**
 * A copy of the launcher whose fixed node locations point at nothing, in a
 * fresh temp dir that can stand in for HOME. The fixed locations are baked
 * into the script, and a CI runner has a real /usr/bin/node — so the
 * environment alone cannot produce "no node anywhere" portably.
 */
function nodelessLauncher(): { dir: string; copy: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-launcher-'));
  const stripped = readFileSync(LAUNCHER, 'utf8').replace(
    /^(\s*)(\/opt\/homebrew|\/usr\/local|\/usr|\/snap)\/bin\/node(\s*\\?)$/gm,
    '$1/nonexistent$2/bin/node$3',
  );
  // Non-vacuity: if the rewrite silently matched nothing, a test would be
  // asserting against the unmodified script and could never fail for the right reason.
  expect(stripped).not.toBe(readFileSync(LAUNCHER, 'utf8'));
  expect(stripped).toContain('/nonexistent/usr/bin/node');
  const copy = join(dir, 'launcher.sh');
  writeFileSync(copy, stripped);
  return { dir, copy };
}

/**
 * Settings that keep the compiled relay out of a run, so the launcher picks
 * the node relay: a compiler that does not exist and an empty cache.
 */
function nodeRelayEnv(): Record<string, string> {
  return {
    CW_RELAY_SWIFTC: '/nonexistent/swiftc',
    CW_RELAY_CACHE_DIR: mkdtempSync(join(tmpdir(), 'cw-launcher-relay-')),
    // A closed port, so no discovery file is read and the relay answers
    // initialize itself at once.
    CW_BASE_URL: 'http://127.0.0.1:9',
    CW_RELAY_INIT_WAIT_MS: '0',
  };
}

/** This machine's bun, or null. The server suite needs it, so CI has one. */
const BUN = (() => {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'launcher-test', version: '0' },
  },
})}\n`;

describe('plugin MCP launcher', () => {
  // Positive control for the negative test below: proves this harness can detect
  // a launcher that fails to start, so "it handshook" is not a vacuous pass.
  it('bare `node` cannot start the relay on a node-less PATH', async () => {
    const { code, stdout, stderr } = await run('node', [RELAY], { stdin: INITIALIZE });

    expect(stdout).not.toContain('"result"');
    expect(code === 0 && stdout.length > 0).toBe(false);
    expect(`${stderr}`).toMatch(/ENOENT|not found|no such file/i);
  });

  // The node relay answers initialize itself when no server answers.
  it('completes an MCP initialize handshake with no node on PATH', async () => {
    const { stdout, stderr } = await run('/bin/sh', [LAUNCHER, RELAY], {
      stdin: INITIALIZE,
      env: { PATH: NODELESS_PATH, HOME: process.env.HOME ?? '', ...nodeRelayEnv() },
    });
    // Which child answered: only the node relay prints this banner.
    expect(stderr).toContain('[relay] node relay started');

    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(
      line,
      `no JSON-RPC line in output: ${JSON.stringify(stdout.slice(0, 400))}`,
    ).toBeTruthy();

    const reply = JSON.parse(line as string);
    expect(reply.id).toBe(1);
    expect(reply.error).toBeUndefined();
    expect(reply.result?.serverInfo?.name).toBeTruthy();

    // The version a client sees had drifted three minor releases behind the
    // plugin manifest, because nothing tied the two together.
    const manifest = JSON.parse(
      // audit: not-source — the manifest is JSON.parse'd and only its
      // `version` and `name` fields are compared to the handshake the running
      // server just answered with; catches the two drifting apart, and asserts
      // on no source text.
      readFileSync(resolve(REPO, 'packages/plugin/.claude-plugin/plugin.json'), 'utf8'),
    );
    expect(reply.result.serverInfo.version).toBe(manifest.version);
    // The NAME had the same freedom to drift and no gate: it read
    // `claude-workspaces` while the manifest said `live-feedback`, and
    // nothing anywhere compared them. Tie it to the manifest so the next
    // rename cannot leave a stale handshake behind.
    expect(reply.result.serverInfo.name).toBe(manifest.name);
  });

  it('runs clean with no HOME and no PATH at all', async () => {
    // cron and a sanitized launchd job hand over an environment with neither. A
    // bare $HOME under `set -u` printed "HOME: unbound variable" here — the fixed
    // locations were still searched, so it wasn't fatal, but it reads like a crash
    // in exactly the situation this launcher exists to handle.
    const stderr = await new Promise<string>((res) => {
      const c = spawn('/bin/sh', [LAUNCHER, RELAY], {
        env: {},
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let out = '';
      c.stderr.on('data', (d) => {
        out += d.toString();
      });
      c.on('close', () => res(out));
    });

    expect(stderr).not.toMatch(/unbound variable|parameter not set/);
  });

  it('fails loudly, not silently, when no node exists anywhere', async () => {
    // Trade-off: this exercises the failure branch and its message, but not the
    // literal contents of the candidate list.
    const { dir, copy } = nodelessLauncher();

    const child = await new Promise<{ code: number | null; stderr: string }>((res) => {
      const c = spawn('/bin/sh', [copy, RELAY], {
        // HOME has no .nvm or .bun, PATH has neither, and the fallbacks now point nowhere.
        // No compiler, because on a Mac the compiled relay needs no node.
        env: { PATH: join(dir, 'empty-bin'), HOME: dir, ...nodeRelayEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      c.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      c.on('close', (code) => res({ code, stderr }));
    });

    expect(child.code).toBe(127);
    expect(child.stderr).toContain('could not find a node or bun binary');
  });

  // A fresh Mac set up from the README has bun and no node, and bun's
  // installer puts it on PATH only through ~/.zshrc — the same trap as nvm.
  it.skipIf(BUN === null)('falls back to bun in ~/.bun when no node exists', async () => {
    const { dir, copy } = nodelessLauncher();
    mkdirSync(join(dir, '.bun', 'bin'), { recursive: true });
    symlinkSync(BUN as string, join(dir, '.bun', 'bin', 'bun'));

    const { stdout } = await run('/bin/sh', [copy, RELAY], {
      stdin: INITIALIZE,
      // The node relay is what has to run under bun here.
      env: { PATH: join(dir, 'empty-bin'), HOME: dir, ...nodeRelayEnv() },
      holdStdin: true,
    });

    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(
      line,
      `no JSON-RPC line in output: ${JSON.stringify(stdout.slice(0, 400))}`,
    ).toBeTruthy();
    expect(JSON.parse(line as string).result?.serverInfo?.name).toBeTruthy();
  });
});

// The full stdio child is no longer shipped. Its last release is tagged, and
// the old lever must say where that is rather than start something else: a
// session that asked for the full child and silently got a relay would be
// debugging the wrong child.
describe('the retired full child', () => {
  it.each([
    ['0', {}],
    ['off', {}],
    // A walled lead with the relay switched off: the same answer, not a
    // second message about the socket.
    ['0', { CW_BOARD_SOCKET: '/nonexistent/board.sock' }],
  ])('CW_MCP_RELAY=%s fails loudly, naming the rollback tag', async (value, extra) => {
    const { code, stdout, stderr } = await run('/bin/sh', [LAUNCHER, RELAY], {
      stdin: INITIALIZE,
      env: {
        PATH: NODELESS_PATH,
        HOME: process.env.HOME ?? '',
        ...nodeRelayEnv(),
        ...extra,
        CW_MCP_RELAY: value,
      },
    });
    expect(code).toBe(64);
    // No child started: nothing on stdout, and no relay banner.
    expect(stdout).toBe('');
    expect(stderr).not.toContain('[relay]');
    const lines = stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ROLLBACK_TAG);
    expect(lines[0]).toContain('CW_MCP_RELAY');
  });

  it('still starts the relay for an old .mcp.json that passes mcp/index.js', async () => {
    // A session holding the previous registration passes the old bundle's
    // path. The launcher only reads its directory, so the relay still runs.
    const { stdout, stderr } = await run('/bin/sh', [LAUNCHER, OLD_BUNDLE], {
      stdin: INITIALIZE,
      env: { PATH: NODELESS_PATH, HOME: process.env.HOME ?? '', ...nodeRelayEnv() },
    });
    expect(stderr).toContain('[relay] node relay started');
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(JSON.parse(line as string).result?.serverInfo?.name).toBeTruthy();
  });

  it('fails with one line when the node relay is missing, rather than start anything', async () => {
    // A plugin dir with no mcp/relay.js and no relay.swift: nothing can reach
    // the board. Before the full child was retired, this fell through to it.
    const dir = mkdtempSync(join(tmpdir(), 'cw-launcher-norelay-'));
    mkdirSync(join(dir, 'mcp'));
    const { code, stdout, stderr } = await run(
      '/bin/sh',
      [LAUNCHER, join(dir, 'mcp', 'relay.js')],
      {
        stdin: INITIALIZE,
        env: { PATH: NODELESS_PATH, HOME: process.env.HOME ?? '', ...nodeRelayEnv() },
      },
    );
    expect(code).toBe(64);
    expect(stdout).toBe('');
    const lines = stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('relay.js is missing');
  });

  it('is not in the plugin tree, and the registration does not name it', () => {
    expect(existsSync(OLD_BUNDLE)).toBe(false);
    expect(existsSync(RELAY)).toBe(true);
    const config = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
    const args: string[] = config.mcpServers['claude-workspaces'].args;
    expect(args.some((a) => a.endsWith('/mcp/index.js'))).toBe(false);
    expect(args).toContain('${CLAUDE_PLUGIN_ROOT}/mcp/relay.js');
  });
});

describe('plugin MCP registration', () => {
  const config = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
  const server = config.mcpServers['claude-workspaces'];

  it('does not invoke a bare interpreter name from PATH', () => {
    // The regression itself: `command` must be an absolute path, since whatever
    // PATH the session inherited is exactly what cannot be trusted here.
    expect(server.command.startsWith('/')).toBe(true);
    expect(server.command).not.toBe('node');
  });

  it('names the one server the plugin ships, and names it after the plugin', () => {
    // This key is half of the tool prefix a session sees —
    // mcp__plugin_<plugin>_<server>__* — so every approved permission entry on
    // every machine is keyed to it. The 2026-08-18 rename moved it from
    // `live-feedback` to `claude-workspaces` deliberately, and that invalidated
    // the old entries; peers re-approve once. Pin it to the manifest so it can
    // only ever move again on purpose.
    const pluginName = JSON.parse(
      // audit: not-source — parsed for its `name` alone, then compared to the
      // key in `.mcp.json`; catches a rename that moves one artifact and
      // leaves the other, which invalidates every approved tool permission.
      readFileSync(resolve(REPO, 'packages/plugin/.claude-plugin/plugin.json'), 'utf8'),
    ).name;
    expect(Object.keys(config.mcpServers)).toEqual([pluginName]);
  });
});
