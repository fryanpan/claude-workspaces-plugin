/**
 * Unit cases for the GitHub relay's parts: reading a broker line, the config
 * file, and holding a push the board did not take. The end-to-end proof is
 * github-relay-two-servers.test.ts.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBrokerLine } from '../src/github-relay/broker-line.ts';
import { loadGithubRelayConfig, parseGithubRelayConfig } from '../src/github-relay/relay-config.ts';
import { createGithubRelay } from '../src/github-relay/relay.ts';

const KEY = 'gp1.w-harbor.abcdefghijklmnopqr.mac';
const secret = (service: string) => {
  if (service === 'cw-github-push-harbor') return KEY;
  if (service === 'cw-harbor-access') return 'the-access-secret';
  throw new Error(`no Keychain entry ${service}`);
};
const board = (over: Record<string, unknown> = {}) => ({
  baseUrl: 'https://harborlight-workspaces.example.com',
  workspaceId: 'w-harbor',
  pushKeyService: 'cw-github-push-harbor',
  serviceToken: { clientId: 'relay.access', secretService: 'cw-harbor-access' },
  ...over,
});

describe('readBrokerLine', () => {
  it.each([
    ['✅ CI **success** on `harborlight/app` (`main` @ 1a2b3c4)', 'ci'],
    ['❌ CI **failure** on `harborlight/app` (`feat` @ 1a2b3c4)', 'ci'],
    ['👀 Review requested on `harborlight/app`: **Fix it**', 'review'],
    ['💬 Mention on `harborlight/app`: **Fix it**', 'mention'],
    ['📌 Assigned on `harborlight/app`: **Fix it**', 'mention'],
    ['🔀 PR #3 merged on `harborlight/app`: **Fix it**', 'merge'],
    ['🚫 PR #3 closed on `harborlight/app`: **Fix it**', 'merge'],
    ['🆕 New issue on `harborlight/app`: **Fix it**', 'issue'],
    ['🚀 Deploy **ci** success on `harborlight/app` (1a2b3c4 @ `main`)', 'deploy'],
    ['💥 Deploy **ci** failure on `harborlight/app` (1a2b3c4 @ `main`)', 'deploy'],
  ])('reads %s', (line, kind) => {
    expect(readBrokerLine(line)).toMatchObject({ repo: 'harborlight/app', kind });
  });

  it('takes the repo from before the title, whatever the title says', () => {
    const e = readBrokerLine('💬 Mention on `harborlight/app`: **see `riverbend/site`**');
    expect(e?.repo).toBe('harborlight/app');
  });

  it('drops a line with no known icon or no repo, and strips what the board refuses', () => {
    expect(readBrokerLine('hello `harborlight/app`')).toBeNull();
    expect(readBrokerLine('✅ CI success somewhere')).toBeNull();
    expect(readBrokerLine(42)).toBeNull();
    expect(readBrokerLine('🆕 New issue on `harborlight/app`: **a‮b\u0007c**')?.text).toBe(
      '🆕 New issue on `harborlight/app`: **abc**',
    );
  });
});

describe('the relay config', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('reads each secret from the Keychain reader, never from the file', () => {
    const c = parseGithubRelayConfig(JSON.stringify({ boards: { harbor: board() } }), secret);
    expect(c).toEqual({
      broker: 'http://127.0.0.1:7902',
      boards: [
        {
          name: 'harbor',
          baseUrl: 'https://harborlight-workspaces.example.com',
          workspaceId: 'w-harbor',
          pushKey: KEY,
          serviceToken: { clientId: 'relay.access', clientSecret: 'the-access-secret' },
        },
      ],
    });
  });

  it.each([
    [
      'a broker off loopback',
      { broker: 'http://broker.example.com:7902', boards: { harbor: board() } },
    ],
    ['plain http off loopback', { boards: { harbor: board({ baseUrl: 'http://example.com' }) } }],
    ['a path on the base URL', { boards: { harbor: board({ baseUrl: 'https://example.com/x' }) } }],
    [
      'a remote board with no service token',
      { boards: { harbor: board({ serviceToken: undefined }) } },
    ],
    ['a missing Keychain entry', { boards: { harbor: board({ pushKeyService: 'cw-nothing' }) } }],
    [
      'a Keychain entry that is not a push key',
      { boards: { harbor: board({ pushKeyService: 'cw-harbor-access' }) } },
    ],
    ['a bad board id', { boards: { harbor: board({ workspaceId: '../w' }) } }],
  ])('refuses %s', (_why, raw) => {
    expect(parseGithubRelayConfig(JSON.stringify(raw), secret)).toHaveProperty('error');
  });

  it('refuses a file anyone but its owner can write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-relay-config-'));
    dirs.push(dir);
    const path = join(dir, 'github-relay.local.json');
    writeFileSync(path, JSON.stringify({ boards: { harbor: board() } }));
    chmodSync(path, 0o664);
    expect(loadGithubRelayConfig(path, secret)).toHaveProperty('error');
    chmodSync(path, 0o600);
    expect(loadGithubRelayConfig(path, secret)).not.toHaveProperty('error');
  });
});

describe('a push the board did not take', () => {
  it('is held on a 5xx and sent again with the same id; a 4xx is dropped', async () => {
    const pushes: Array<{ id: string; status: number }> = [];
    const answers = [503, 200, 400];
    let queued = ['🔀 PR #1 merged on `harborlight/app`: **One**'];
    const fetch = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/state')
        return Response.json({ sessions: [{ id: 's1', repos: ['harborlight/app'] }] });
      if (path === '/register') return Response.json({ id: 's1' });
      if (path === '/poll') {
        const events = queued;
        queued = [];
        return Response.json({ events });
      }
      if (path.endsWith('/github/subscriptions')) {
        return Response.json({ subscriptions: [{ repo: 'harborlight/app', kinds: ['merge'] }] });
      }
      const status = answers.shift() ?? 200;
      pushes.push({ id: (JSON.parse(String(init.body)) as { id: string }).id, status });
      return new Response('{}', { status });
    };
    const config = parseGithubRelayConfig(JSON.stringify({ boards: { harbor: board() } }), secret);
    if ('error' in config) throw new Error(config.error);
    const logs: string[] = [];
    const relay = createGithubRelay({ config, fetch, log: (l) => logs.push(l) });
    await relay.pollOnce();
    await relay.pollOnce();
    expect(pushes).toHaveLength(2);
    expect(pushes[0]?.id).toBe(pushes[1]?.id as string);
    queued = ['🔀 PR #2 merged on `harborlight/app`: **Two**'];
    await relay.pollOnce();
    await relay.pollOnce();
    expect(pushes.map((p) => p.status)).toEqual([503, 200, 400]);
    expect(logs.some((l) => l.includes('refused with 400'))).toBe(true);
  });
});
