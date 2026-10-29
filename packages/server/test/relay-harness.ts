/**
 * Drives a session's MCP child over stdio, the way Claude Code does: one
 * JSON-RPC message per line in, one per line out. `relay-stdio.test.ts` uses
 * it to run the compiled relay, the node relay and today's full child through
 * the same cases.
 *
 * Every child is started through the plugin's own launcher
 * (packages/plugin/bin/claude-workspaces-mcp.sh), so a test proves the
 * launcher chose the child it names, not just that the child works.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { waitFor } from './wait-for.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const LAUNCHER = join(REPO, 'packages/plugin/bin/claude-workspaces-mcp.sh');
export const BUNDLE = join(REPO, 'packages/plugin/mcp/index.js');

export type ChildKind = 'compiled' | 'node-relay' | 'full';

/** The launcher settings that select each child. */
export interface ChildArm {
  kind: ChildKind;
  env: Record<string, string>;
}

/** A PATH that finds the node running this test, and the system tools. */
function pathWithNode(): string {
  const node = spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
  return [node ? dirname(node) : '', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter(Boolean)
    .join(':');
}
export const PATH_WITH_NODE = pathWithNode();

/**
 * What the launcher would run under `env`, asked through its print seam. For
 * the compiled arm this is also what BUILDS the relay, so it is called once
 * before any case runs.
 */
export function launcherChoice(env: Record<string, string>): string {
  const r = spawnSync('/bin/sh', [LAUNCHER, BUNDLE], {
    env: { PATH: PATH_WITH_NODE, HOME: tmpdir(), ...env, CW_MCP_PRINT_CHILD: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return r.stdout.trim();
}

/**
 * The compiled arm, or null where this machine cannot build it. The cache is
 * shared across runs (keyed by the source's hash, as in production), so only
 * the first run on a machine pays for the build.
 */
export function compiledArm(): ChildArm | null {
  if (process.platform !== 'darwin') return null;
  const env = { CW_RELAY_CACHE_DIR: join(tmpdir(), 'cw-relay-test-cache') };
  return launcherChoice(env).startsWith('compiled ') ? { kind: 'compiled', env } : null;
}

/** The node relay: a compiler that does not exist, so the launcher falls back. */
export function nodeRelayArm(): ChildArm {
  return {
    kind: 'node-relay',
    env: {
      CW_RELAY_SWIFTC: '/nonexistent/swiftc',
      CW_RELAY_CACHE_DIR: mkdtempSync(join(tmpdir(), 'cw-relay-empty-')),
    },
  };
}

/** Today's child, in full, through the rollback lever. */
export const FULL_ARM: ChildArm = { kind: 'full', env: { CW_MCP_RELAY: '0' } };

export interface StdioChild {
  kind: ChildKind;
  /** Every message the child wrote, parsed, in order. */
  messages: Record<string, unknown>[];
  stderr(): string;
  /** Send a request and wait for its answer. */
  request(method: string, params?: unknown, timeout?: number): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  /** initialize, then notifications/initialized. Returns the initialize answer. */
  handshake(): Promise<Record<string, unknown>>;
  /** Result of a tools/call, as the first text content parsed when it is JSON. */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }>;
  /** Every `notifications/claude/channel` params the child wrote. */
  channel(): Record<string, unknown>[];
  pid: number;
  exited(): boolean;
  stop(): Promise<void>;
}

/**
 * `prefix` runs the launcher under another command, e.g. `sandbox-exec -f
 * <profile>`, which execs it, so `pid` is still the child's.
 */
export function startChild(
  arm: ChildArm,
  env: Record<string, string>,
  cwd: string,
  prefix: string[] = [],
): StdioChild {
  const [file, ...args] = [...prefix, '/bin/sh', LAUNCHER, BUNDLE];
  const proc: ChildProcess = spawn(file ?? '/bin/sh', args, {
    cwd,
    env: {
      PATH: PATH_WITH_NODE,
      HOME: mkdtempSync(join(tmpdir(), 'cw-relay-home-')),
      ...arm.env,
      ...env,
      CW_AUTHOR: 'agent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Record<string, unknown>[] = [];
  let err = '';
  let buf = '';
  let exited = false;
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (c: string) => {
    err += c;
  });
  proc.on('exit', () => {
    exited = true;
  });
  let nextId = 100;
  const send = (msg: unknown) => proc.stdin?.write(`${JSON.stringify(msg)}\n`);
  const child: StdioChild = {
    kind: arm.kind,
    messages,
    stderr: () => err,
    pid: proc.pid ?? -1,
    exited: () => exited,
    async request(method, params = {}, timeout = 10_000) {
      nextId += 1;
      const id = nextId;
      send({ jsonrpc: '2.0', id, method, params });
      return waitFor(() => messages.find((m) => m.id === id), {
        timeout,
        describe: `${arm.kind} to answer ${method}`,
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    async handshake() {
      const init = await child.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'relay-stdio-test', version: '0.0.0' },
      });
      child.notify('notifications/initialized');
      return init;
    },
    async callTool(name, args) {
      const answer = await child.request('tools/call', { name, arguments: args });
      const result = answer.result as { isError?: boolean; content?: { text?: string }[] };
      return { isError: result?.isError === true, text: result?.content?.[0]?.text ?? '' };
    },
    channel: () =>
      messages
        .filter((m) => m.method === 'notifications/claude/channel')
        .map((m) => m.params as Record<string, unknown>),
    async stop() {
      if (exited) return;
      proc.stdin?.end();
      try {
        await waitFor(() => exited, {
          timeout: 3000,
          describe: `${arm.kind} to exit on stdin EOF`,
        });
      } catch {
        // By pid, never by pattern: this process and nothing else.
        proc.kill('SIGKILL');
      }
    },
  };
  return child;
}
