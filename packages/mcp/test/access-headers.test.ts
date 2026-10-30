/**
 * A session whose board is behind Cloudflare Access sends the service
 * token's two headers on every request its child makes, and never says the
 * secret anywhere.
 *
 * Both children are driven against a real HTTP server on loopback, through
 * the real global fetch wrapped by `serverFetch`, so what is asserted is what
 * went on the wire: the full child's REST call, token mint and event stream,
 * and the node relay's mint, `/mcp` POSTs and `/mcp` stream. The Keychain is
 * never read; the reader is injected. Names are fictional.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Fetch, accessTokenFrom, serverFetch } from '../src/access-headers.ts';
import { resolveAgentAuthor } from '../src/author.ts';
import { createConnectorSession } from '../src/connector-session.ts';
import { createRelay } from '../src/relay/relay-core.ts';

const CLIENT_ID = 'riverbend-fixture.access';
const SECRET = 'harborlight-planted-secret-4f1c';
const SERVICE = 'cw-riverbend-access-secret';
const ACCESS_ENV = { CW_ACCESS_CLIENT_ID: CLIENT_ID, CW_ACCESS_SECRET_SERVICE: SERVICE };
const reader = (service: string) => {
  if (service !== SERVICE) throw new Error('unexpected service');
  return `${SECRET}\n`;
};

interface Seen {
  method: string;
  path: string;
  id: string | undefined;
  secret: string | undefined;
}

let server: Server;
let base: string;
let seen: Seen[];
const streams = new Set<ServerResponse>();

function json(res: ServerResponse, value: unknown, extra: Record<string, string> = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(value));
}

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  seen.push({
    method: req.method ?? 'GET',
    path,
    id: header('cf-access-client-id'),
    secret: header('cf-access-client-secret'),
  });
  if (path.endsWith('/token') || path === '/api/agent-token') {
    return json(res, { token: 'at.fixture' });
  }
  if (path.endsWith('/watches')) return json(res, { watches: [] });
  const wantsStream = (header('accept') ?? '').startsWith('text/event-stream');
  if (
    path.startsWith('/events/agent/') ||
    (path === '/mcp' && req.method === 'GET') ||
    wantsStream
  ) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(':ok\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
    return;
  }
  if (path === '/mcp' && req.method === 'POST') {
    const rpc = JSON.parse(body) as { id?: number; method?: string };
    if (rpc.method === 'initialize') {
      return json(
        res,
        { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } },
        { 'mcp-session-id': 'sid-1' },
      );
    }
    res.writeHead(202);
    return res.end();
  }
  return json(res, { ok: true, docId: 'plan' });
}

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => handle(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of streams) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`condition never held; saw ${JSON.stringify(seen.map((s) => s.path))}`);
}

const realFetch: Fetch = (url, init) => fetch(url, init);

/** The full child: a REST tool call, then the event stream with its token mint. */
async function driveFullChild(env: Record<string, string>, logs: string[]) {
  const session = createConnectorSession({
    author: resolveAgentAuthor({ CW_AGENT_NAME: 'Riverbend Alpha' }),
    cwd: '/work/riverbend',
    defaultWorkspaceId: () => '',
    pluginVersion: () => '0.0.0',
    processId: 'process-riverbend',
    notify: async () => {},
    resolveBaseUrl: () => base,
    fetch: serverFetch(env, realFetch, (l) => logs.push(l), reader),
    log: (...args) => logs.push(args.map(String).join(' ')),
  });
  try {
    const res = await session.callTool({
      method: 'tools/call',
      params: {
        name: 'attach_markdown',
        arguments: { workspaceId: 'w-1', docId: 'plan', path: '/work/plan.md', subscribe: false },
      },
    });
    await session.openEvents();
    await waitFor(() => seen.some((s) => s.path.startsWith('/events/agent/')));
    return JSON.stringify(res);
  } finally {
    session.stop();
  }
}

/** The node relay: initialize (mint + POST), initialized (POST + stream). */
async function driveRelay(env: Record<string, string>, logs: string[]) {
  const written: string[] = [];
  const relay = createRelay({
    env: { CW_BASE_URL: base, CW_AGENT_NAME: 'Riverbend Alpha', ...env },
    cwd: '/work/riverbend',
    homedir: () => '/nonexistent',
    existsSync: () => false,
    readFileSync: () => '',
    fetch: serverFetch(env, realFetch, (l) => logs.push(l), reader),
    write: (line) => written.push(line),
    log: (...args) => logs.push(args.map(String).join(' ')),
    initWaitMs: 2000,
  });
  try {
    relay.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await waitFor(() => written.length > 0);
    relay.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await waitFor(() => seen.some((s) => s.path === '/mcp' && s.method === 'GET'));
    return written.join('\n');
  } finally {
    await relay.close();
  }
}

const kinds = () => seen.map((s) => `${s.method} ${s.path}`);

describe('the full child behind Access', () => {
  it('sends both headers on the REST call, the token mint and the event stream', async () => {
    await driveFullChild(ACCESS_ENV, []);
    const k = kinds();
    expect(k).toContain('POST /workspaces/w-1/docs');
    expect(k.some((x) => /^GET \/api\/agents\/[^/]+\/token$/.test(x))).toBe(true);
    expect(k.some((x) => /^GET \/events\/agent\/[^/]+$/.test(x))).toBe(true);
    for (const s of seen) {
      expect({ path: s.path, id: s.id, secret: s.secret }).toEqual({
        path: s.path,
        id: CLIENT_ID,
        secret: SECRET,
      });
    }
  });

  it('sends neither header when nothing is configured', async () => {
    await driveFullChild({}, []);
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) expect([s.id, s.secret]).toEqual([undefined, undefined]);
  });
});

describe('the node relay behind Access', () => {
  it('sends both headers on the mint, the /mcp POSTs and the /mcp stream', async () => {
    await driveRelay(ACCESS_ENV, []);
    const k = kinds();
    expect(k).toContain('GET /api/agent-token');
    expect(k.filter((x) => x === 'POST /mcp').length).toBeGreaterThanOrEqual(2);
    expect(k).toContain('GET /mcp');
    for (const s of seen) expect([s.path, s.id, s.secret]).toEqual([s.path, CLIENT_ID, SECRET]);
  });

  it('sends neither header when nothing is configured', async () => {
    await driveRelay({}, []);
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) expect([s.id, s.secret]).toEqual([undefined, undefined]);
  });
});

describe('the secret is never said', () => {
  it('appears in no log line, tool result or relay output, even when the server refuses', async () => {
    const logs: string[] = [];
    const toolResult = await driveFullChild(ACCESS_ENV, logs);
    const relayOut = await driveRelay(ACCESS_ENV, logs);
    // A refusal from Access, and a server that is gone, both produce errors.
    const refusing = serverFetch(ACCESS_ENV, realFetch, (l) => logs.push(l), reader);
    await refusing('http://127.0.0.1:1/', {}).catch((e: unknown) => logs.push(String(e)));
    const said = [...logs, toolResult, relayOut].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(CLIENT_ID);
  });

  it('names the variable, never its value, when the configuration is refused', () => {
    const cases = [
      { CW_ACCESS_CLIENT_ID: CLIENT_ID },
      { CW_ACCESS_SECRET_SERVICE: SERVICE },
      { CW_ACCESS_CLIENT_ID: 'harborlight-not-an-id', CW_ACCESS_SECRET_SERVICE: SERVICE },
    ];
    for (const env of cases) {
      const r = accessTokenFrom(env, reader);
      expect(r !== null && 'error' in r).toBe(true);
      expect(JSON.stringify(r)).not.toContain('harborlight');
      expect(JSON.stringify(r)).not.toContain(CLIENT_ID);
    }
    const unreadable = accessTokenFrom(ACCESS_ENV, () => {
      throw new Error(`leaked ${SECRET}`);
    });
    expect(JSON.stringify(unreadable)).not.toContain(SECRET);
  });

  it('keeps the secret off a plain-http origin that is not loopback', async () => {
    const urls: string[] = [];
    const headersOf: Headers[] = [];
    const capture: Fetch = async (url, init) => {
      urls.push(url);
      headersOf.push(new Headers(init?.headers));
      return new Response('{}');
    };
    const f = serverFetch(ACCESS_ENV, capture, () => {}, reader);
    await f('http://saltmarsh.example/api/x');
    await f('https://saltmarsh.example/api/x');
    expect(headersOf.map((h) => h.get('cf-access-client-secret'))).toEqual([null, SECRET]);
  });
});

describe('the launcher under Access', () => {
  const REPO = resolve(__dirname, '../../..');
  const LAUNCHER = resolve(REPO, 'packages/plugin/bin/claude-workspaces-mcp.sh');
  const BUNDLE = resolve(REPO, 'packages/plugin/mcp/index.js');

  // A stand-in compiler whose output passes --self-test, so the compiled arm
  // is reachable without swiftc. /sbin/md5 keys the cache, so macOS only.
  it.skipIf(process.platform !== 'darwin')(
    'takes the node relay, which reads Keychain, rather than the compiled one',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cw-access-launcher-'));
      const fakeSwiftc = join(dir, 'swiftc');
      writeFileSync(
        fakeSwiftc,
        '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$2"\nchmod +x "$2"\n',
      );
      chmodSync(fakeSwiftc, 0o755);
      const choice = (extra: Record<string, string>) =>
        spawnSync('/bin/sh', [LAUNCHER, BUNDLE], {
          env: {
            PATH: `${process.env.PATH ?? ''}`,
            HOME: dir,
            CW_RELAY_SWIFTC: fakeSwiftc,
            CW_RELAY_CACHE_DIR: join(dir, 'cache'),
            CW_MCP_PRINT_CHILD: '1',
            ...extra,
          },
          encoding: 'utf8',
          timeout: 30_000,
        }).stdout.trim();
      // Control: without Access the stand-in build is taken.
      expect(choice({})).toMatch(/^compiled /);
      expect(choice({ CW_ACCESS_CLIENT_ID: CLIENT_ID })).toBe('node-relay');
    },
  );
});
