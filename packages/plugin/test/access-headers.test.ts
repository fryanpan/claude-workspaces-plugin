/**
 * The plugin's hooks send the Access service token to a board behind
 * Cloudflare Access, and the token goes to the configured server's origin
 * and nowhere else: not to another origin, not across a redirect that leaves
 * the origin, and not over plain http to a host that is not loopback. The
 * Keychain is never read; the reader is injected. Names are fictional.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fetch,
  RETRY_AFTER_MS,
  readKeychainSecret,
  serverFetch,
} from '../hooks/lib/access-headers.ts';
import { runHook } from '../hooks/lib/agent-notes.ts';
import { runPromptHook } from '../hooks/lib/prompt-mark.ts';

const CLIENT_ID = 'saltmarsh-fixture.access';
const SECRET = 'riverbend-planted-secret-9a2e';
const SERVICE = 'cw-saltmarsh-access-secret';
const ACCESS = { CW_ACCESS_CLIENT_ID: CLIENT_ID, CW_ACCESS_SECRET_SERVICE: SERVICE };
const reader = () => SECRET;

type Call = { url: string; headers: Headers };
function capture(calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response('{"ok":true}', { status: 202 });
  }) as unknown as typeof fetch;
}
const pair = (c: Call) => [
  c.headers.get('cf-access-client-id'),
  c.headers.get('cf-access-client-secret'),
];

const BOARD = { CW_AGENT_NAME: 'Harborlight lead', CW_WORKSPACE_ID: 'w-harbor' };
const STOP = {
  session_id: 's-1',
  cwd: '/work/harborlight',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Moved berth 4.',
};

describe('the hooks behind Access', () => {
  const env = { ...BOARD, ...ACCESS, CW_BASE_URL: 'https://harborlight.example' };

  it('the Stop hook note carries both headers', async () => {
    const calls: Call[] = [];
    await runHook('turn', JSON.stringify(STOP), {
      env,
      fetch: capture(calls),
      now: () => 1,
      readSecret: reader,
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/workspaces/w-harbor/agents/Harborlight%20lead/notes',
    ]);
    expect(calls.map(pair)).toEqual([[CLIENT_ID, SECRET]]);
  });

  it('the prompt mark carries both headers', async () => {
    const calls: Call[] = [];
    const ok = await runPromptHook(JSON.stringify({ prompt: 'hello', session_id: 's-1' }), {
      env,
      fetch: capture(calls),
      readSecret: reader,
    });
    expect(ok).toBe(true);
    expect(calls.map(pair)).toEqual([[CLIENT_ID, SECRET]]);
  });

  it('sends neither header when nothing is configured', async () => {
    const calls: Call[] = [];
    await runHook('turn', JSON.stringify(STOP), {
      env: { ...BOARD, CW_BASE_URL: 'https://harborlight.example' },
      fetch: capture(calls),
      now: () => 1,
      readSecret: reader,
    });
    expect(calls.map(pair)).toEqual([[null, null]]);
  });
});

describe('where the headers go', () => {
  it('only to the base URL origin, not to another https origin', async () => {
    const calls: Call[] = [];
    const f = serverFetch(
      ACCESS,
      capture(calls) as Fetch,
      () => {},
      () => 'https://harborlight.example',
      reader,
    );
    await f('https://harborlight.example/api/x');
    await f('https://saltmarsh.example/api/x');
    expect(calls.map(pair)).toEqual([
      [CLIENT_ID, SECRET],
      [null, null],
    ]);
  });

  it('not over plain http to a host that is not loopback, and says so once', async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const f = serverFetch(
      ACCESS,
      capture(calls) as Fetch,
      (l) => logs.push(l),
      () => 'http://harborlight.example',
      reader,
    );
    await f('http://harborlight.example/a');
    await f('http://harborlight.example/b');
    expect(calls.map(pair)).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(logs).toEqual([
      'Access headers dropped: the base URL is plain http on a host that is not loopback',
    ]);
  });
});

describe('a redirect', () => {
  interface Seen {
    server: string;
    path: string;
    id: string | undefined;
    secret: string | undefined;
    auth: string | undefined;
  }
  let seen: Seen[];
  let home: Server;
  let away: Server;
  let homeBase: string;
  let awayBase: string;

  const listen = (name: string, route: (req: IncomingMessage, res: ServerResponse) => void) =>
    createServer((req, res) => {
      const h = (k: string) => req.headers[k] as string | undefined;
      seen.push({
        server: name,
        path: req.url ?? '',
        id: h('cf-access-client-id'),
        secret: h('cf-access-client-secret'),
        auth: h('authorization'),
      });
      route(req, res);
    });
  const start = (s: Server) =>
    new Promise<string>((r) =>
      s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
    );

  beforeEach(async () => {
    seen = [];
    away = listen('away', (_req, res) => res.end('{}'));
    awayBase = await start(away);
    home = listen('home', (req, res) => {
      if (req.url === '/same') {
        res.writeHead(302, { location: '/landed' });
        res.end();
      } else if (req.url === '/leave') {
        res.writeHead(307, { location: `${awayBase}/landed` });
        res.end();
      } else if (req.url === '/see-other') {
        res.writeHead(303, { location: `${awayBase}/other` });
        res.end();
      } else {
        res.end('{}');
      }
    });
    homeBase = await start(home);
  });
  afterEach(async () => {
    await new Promise((r) => home.close(r));
    await new Promise((r) => away.close(r));
  });

  // Both servers are loopback on different ports: two origins, as a
  // redirect from a board to anywhere else would be.
  it('to another origin goes without the headers; one on the origin keeps them', async () => {
    const f = serverFetch(
      ACCESS,
      (u, i) => fetch(u, i),
      () => {},
      () => homeBase,
      reader,
    );
    // The agent's bearer rides along, as the MCP child's requests carry it.
    const bearer = { authorization: 'Bearer at2.fixture' };
    expect((await f(`${homeBase}/same`, { headers: bearer })).status).toBe(200);
    const post = { method: 'POST', body: '{}', headers: bearer };
    expect((await f(`${homeBase}/leave`, post)).status).toBe(200);
    expect((await f(`${homeBase}/see-other`, post)).status).toBe(200);
    const row = (s: Seen) => [s.server, s.path, s.id ?? null, s.secret ?? null, s.auth ?? null];
    const AT2 = 'Bearer at2.fixture';
    expect(seen.map(row)).toEqual([
      ['home', '/same', CLIENT_ID, SECRET, AT2],
      ['home', '/landed', CLIENT_ID, SECRET, AT2],
      ['home', '/leave', CLIENT_ID, SECRET, AT2],
      ['away', '/landed', null, null, null],
      ['home', '/see-other', CLIENT_ID, SECRET, AT2],
      ['away', '/other', null, null, null],
    ]);
  });
});

describe('the Keychain read', () => {
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-keychain-'));
    const bin = join(dir, 'security');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  it('gives up after its timeout rather than waiting on a dialog, and says it timed out', () => {
    const slow = script('sleep 5\necho never');
    expect(() => readKeychainSecret(SERVICE, 100, slow)).toThrow(/timed out/);
  });

  it('says an entry is missing when the read answers that', () => {
    expect(() => readKeychainSecret(SERVICE, 5000, script('exit 44'))).toThrow(/no Keychain entry/);
  });

  it('tries a failed read again after the backoff, and says each failure once', async () => {
    let clock = 0;
    let reads = 0;
    let fails = true;
    const flaky = () => {
      reads++;
      if (fails) throw new Error('locked');
      return SECRET;
    };
    const calls: Call[] = [];
    const logs: string[] = [];
    const f = serverFetch(
      ACCESS,
      capture(calls) as Fetch,
      (l) => logs.push(l),
      () => 'https://harborlight.example',
      flaky,
      () => clock,
    );
    const url = 'https://harborlight.example/api/x';
    await f(url);
    await f(url); // inside the backoff: not read again
    clock += RETRY_AFTER_MS;
    await f(url); // read again, fails the same way: not said again
    clock += RETRY_AFTER_MS;
    fails = false;
    await f(url);
    await f(url); // a success is kept
    expect(reads).toBe(3);
    expect(calls.map(pair)).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [CLIENT_ID, SECRET],
      [CLIENT_ID, SECRET],
    ]);
    expect(logs).toEqual([
      `Access headers off: the Keychain service ${SERVICE} could not be read`,
      'sending the Access service token on requests to the server',
    ]);
  });
});
