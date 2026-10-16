/**
 * The relay's pure parts and its one network adapter: the config and the
 * permission check that guards it, the organization rule, the fixed checks,
 * the outbox line, the classifier's reply, and the headers every call to a
 * project server carries. Every key and token here is fake, made in the test.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOutbox } from '../src/org-relay/relay-client.ts';
import {
  type RelayConfig,
  loadRelayConfig,
  parseRelayConfig,
} from '../src/org-relay/relay-config.ts';
import { haikuRelayFilter, parseRelayFilterResponse } from '../src/org-relay/relay-filter.ts';
import { createRelayStore } from '../src/org-relay/relay-log.ts';
import { applyOrganizationRule, fixedCheckHit } from '../src/org-relay/relay-rule.ts';
import { createRelay, parseOutboxText } from '../src/org-relay/relay.ts';

const fake = () => `test-${crypto.randomUUID()}`;
const serviceToken = { clientId: `${fake()}.access`, clientSecret: fake() };

const config = (over: { servers?: object; seats?: object } = {}) => ({
  servers: {
    harbor: {
      organization: 'harborlight',
      baseUrl: 'https://workspaces.harborlight.test',
      serviceToken,
      bearers: { 'w-harbor': fake() },
    },
    river: {
      organization: 'riverbend',
      baseUrl: 'http://127.0.0.1:9',
      bearers: { 'w-river': fake() },
    },
    ...over.servers,
  },
  seats: {
    'harbor-lead': {
      server: 'harbor',
      board: 'w-harbor',
      agentId: 'agent-harbor-lead',
      outboxDoc: 'task:t-out-1',
      inboxDoc: 'task:t-in-1',
    },
    'harbor-writer': {
      server: 'harbor',
      board: 'w-harbor',
      agentId: 'agent-harbor-writer',
      outboxDoc: 'task:t-out-2',
      inboxDoc: 'task:t-in-2',
      untrusted: true,
    },
    'river-lead': {
      server: 'river',
      board: 'w-river',
      agentId: 'agent-river-lead',
      outboxDoc: 'task:t-out-3',
      inboxDoc: 'task:t-in-3',
      crossOrganization: true,
    },
    ...over.seats,
  },
});

const parsed = (raw: object): RelayConfig => {
  const c = parseRelayConfig(JSON.stringify(raw));
  if ('error' in c) throw new Error(c.error);
  return c;
};

describe('the relay config', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('takes each seat’s organization from its server', () => {
    const c = parsed(config());
    expect(c.seats.get('harbor-lead')?.organization).toBe('harborlight');
    expect(c.seats.get('river-lead')?.organization).toBe('riverbend');
  });

  it('refuses a seat that names its own organization', () => {
    const raw = config();
    (raw.seats['harbor-lead'] as Record<string, unknown>).organization = 'riverbend';
    expect(parseRelayConfig(JSON.stringify(raw))).toEqual({
      error: 'seat harbor-lead names an organization; its server decides that',
    });
  });

  it('refuses a remote server with no service token, and plain http off loopback', () => {
    const noToken = config({
      servers: {
        harbor: {
          organization: 'harborlight',
          baseUrl: 'https://h.harborlight.test',
          bearers: { 'w-harbor': fake() },
        },
      },
    });
    expect(parseRelayConfig(JSON.stringify(noToken))).toEqual({
      error: 'server harbor is remote and carries no service token',
    });
    const plain = config({
      servers: {
        harbor: {
          organization: 'harborlight',
          baseUrl: 'http://h.harborlight.test',
          serviceToken,
          bearers: { 'w-harbor': fake() },
        },
      },
    });
    expect(parseRelayConfig(JSON.stringify(plain))).toEqual({
      error: 'server harbor baseUrl must be https unless it is loopback',
    });
  });

  it('refuses a seat on a board its server holds no bearer for', () => {
    const raw = config();
    (raw.seats['harbor-lead'] as Record<string, unknown>).board = 'w-elsewhere';
    expect(parseRelayConfig(JSON.stringify(raw))).toEqual({
      error: 'seat harbor-lead is on a board its server holds no bearer for',
    });
  });

  it('refuses two seats on one outbox', () => {
    const raw = config();
    (raw.seats['harbor-writer'] as Record<string, unknown>).outboxDoc = 'task:t-out-1';
    expect('error' in parseRelayConfig(JSON.stringify(raw))).toBe(true);
  });

  it('refuses a file anyone but its owner can read, and loads a mode-600 one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
    dirs.push(dir);
    const path = join(dir, 'relay.json');
    writeFileSync(path, JSON.stringify(config()));
    chmodSync(path, 0o640);
    expect(loadRelayConfig(path)).toEqual({ error: `${path} is readable by others; chmod 600 it` });
    chmodSync(path, 0o604);
    expect('error' in loadRelayConfig(path)).toBe(true);
    chmodSync(path, 0o600);
    expect('error' in loadRelayConfig(path)).toBe(false);
  });
});

describe('the organization rule', () => {
  const c = parsed(config());

  it('allows inside an organization without the filter, unless the sender is untrusted', () => {
    const swapped = parsed(
      config({
        seats: {
          'harbor-writer': {
            server: 'harbor',
            board: 'w-harbor',
            agentId: 'agent-harbor-writer',
            outboxDoc: 'task:t-out-2',
            inboxDoc: 'task:t-in-2',
          },
        },
      }),
    );
    expect(applyOrganizationRule(swapped, 'harbor-writer', 'harbor-lead', 'hi')).toMatchObject({
      kind: 'allow',
      filter: false,
      crossOrganization: false,
    });
    expect(applyOrganizationRule(c, 'harbor-writer', 'harbor-lead', 'hi')).toMatchObject({
      kind: 'allow',
      filter: true,
    });
  });

  it('refuses across organizations unless the SENDER holds that access', () => {
    expect(applyOrganizationRule(c, 'harbor-lead', 'river-lead', 'hi')).toEqual({
      kind: 'refuse',
      reason: 'cross-organization',
    });
    expect(applyOrganizationRule(c, 'river-lead', 'harbor-lead', 'hi')).toMatchObject({
      kind: 'allow',
      crossOrganization: true,
      filter: true,
    });
  });

  it('refuses unknown seats, an empty message and an over-long one', () => {
    expect(applyOrganizationRule(c, 'nobody', 'harbor-lead', 'hi')).toMatchObject({
      reason: 'unknown-sender',
    });
    expect(applyOrganizationRule(c, 'harbor-lead', 'nobody', 'hi')).toMatchObject({
      reason: 'unknown-recipient',
    });
    expect(applyOrganizationRule(c, 'river-lead', 'harbor-lead', '  ')).toMatchObject({
      reason: 'empty',
    });
    expect(applyOrganizationRule(c, 'river-lead', 'harbor-lead', 'x'.repeat(8001))).toMatchObject({
      reason: 'too-long',
    });
  });
});

describe('the fixed checks', () => {
  it('trip on an address, a Mac path, a secret shape and hidden characters', () => {
    expect(fixedCheckHit(`write to ${['someone', 'harborlight.test'].join('@')}`)).toBe('email');
    expect(fixedCheckHit('see /Users/riverbend/notes.md')).toBe('mac-path');
    expect(fixedCheckHit(`key ${['sk', 'ant', 'api03'].join('-')}-${'a'.repeat(20)}`)).toBe(
      'secret-shape',
    );
    expect(fixedCheckHit(`fine${String.fromCodePoint(0xe0041)}`)).toBe('hidden-text');
  });

  it('pass ordinary coordination', () => {
    expect(fixedCheckHit('The Riverbend schedule moved to Thursday; see task 12.')).toBeNull();
  });
});

describe('the outbox line', () => {
  it('reads the recipient from the first line and the message from the rest', () => {
    expect(parseOutboxText('to: harbor-lead\nLine one\nLine two')).toEqual({
      to: 'harbor-lead',
      text: 'Line one\nLine two',
    });
    expect(parseOutboxText('Hello there')).toBeNull();
    expect(parseOutboxText('to: two words\nx')).toBeNull();
  });
});

describe('the classifier', () => {
  it('reads a verdict and refuses anything that is not one', () => {
    expect(parseRelayFilterResponse('{"hold": false}')).toEqual({ hold: false });
    expect(parseRelayFilterResponse('ok {"hold": true, "reason": "asks for keys"}')).toEqual({
      hold: true,
      reason: 'asks for keys',
    });
    expect(parseRelayFilterResponse('{"hold": "maybe"}')).toBeNull();
    expect(parseRelayFilterResponse('no json')).toBeNull();
  });

  it('throws on a non-2xx and on an unreadable reply, so the relay holds', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const input = {
      text: 'x',
      fromSeat: 'a',
      fromOrganization: 'o1',
      toSeat: 'b',
      toOrganization: 'o2',
    };
    const down = haikuRelayFilter({ apiKey: 'k-test', fetchImpl: answer(529, {}) });
    await expect(down?.(input)).rejects.toThrow('HTTP 529');
    const garbled = haikuRelayFilter({
      apiKey: 'k-test',
      fetchImpl: answer(200, { content: [{ type: 'text', text: 'sure' }] }),
    });
    await expect(garbled?.(input)).rejects.toThrow('not a verdict');
    expect(haikuRelayFilter({ apiKey: null })).toBeNull();
  });
});

describe('a call to a project server', () => {
  it('carries the service-token pair and the bearer, and nothing from the message', async () => {
    const c = parsed(config());
    const harbor = c.servers.get('harbor');
    if (!harbor) throw new Error('no server');
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ threads: [] });
    };
    expect(await readOutbox(fetchFn, harbor, 'w-harbor', 'task:t-out-1')).toEqual([]);
    expect(seen[0]?.url).toBe(
      'https://workspaces.harborlight.test/workspaces/w-harbor/docs/task%3At-out-1/threads?status=open',
    );
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${harbor.bearers.get('w-harbor')}`);
    expect(seen[0]?.headers.get('cf-access-client-id')).toBe(serviceToken.clientId);
    expect(seen[0]?.headers.get('cf-access-client-secret')).toBe(serviceToken.clientSecret);
  });
});

describe('the relay state files', () => {
  it('are mode 600 in a mode-700 directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
    try {
      const store = createRelayStore(join(dir, 'state'));
      store.append({
        ts: 1,
        id: 'a:1',
        from: 'a',
        to: 'b',
        fromOrganization: 'o',
        toOrganization: 'o',
        verdict: 'refused',
      });
      store.hold({ ts: 1, id: 'a:2', from: 'a', to: 'b', reason: 'r', text: 't' });
      expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'state', 'relay-log.jsonl')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'state', 'relay-held.jsonl')).mode & 0o777).toBe(0o600);
      expect([...store.handledIds()]).toEqual(['a:1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a delivery that fails in transit', () => {
  it('gets no verdict, and its retry is delivered without asking the filter again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-retry-'));
    try {
      const store = createRelayStore(dir);
      let judged = 0;
      let posts = 0;
      const relay = createRelay({
        config: parsed(config()),
        store,
        filter: async () => {
          judged += 1;
          return { hold: false };
        },
        fetch: async () => {
          posts += 1;
          return new Response('{}', { status: posts === 1 ? 502 : 200 });
        },
        log: () => {},
      });
      const message = { id: 'river-lead:t1', from: 'river-lead', to: 'harbor-lead', text: 'hi' };
      expect(await relay.handle(message)).toEqual({ verdict: 'failed', reason: 'delivery-failed' });
      expect(store.entries()).toEqual([]);
      expect(await relay.handle(message)).toEqual({ verdict: 'delivered' });
      expect(judged).toBe(1);
      expect(store.entries().map((e) => e.verdict)).toEqual(['delivered']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
