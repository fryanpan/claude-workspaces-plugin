/**
 * No route a board member can call returns a private message between two
 * other people (M10).
 *
 * Alice writes to Bob, and to her own lead agent. Then every address in
 * `ROUTE_TABLE` is called by three callers who are party to neither
 * conversation:
 *
 *   - Riverbend, a board member proving herself on the share host. Every
 *     method each row answers, with a `{}` body on a write.
 *   - The board's owner, in their own browser on the owner host, which
 *     reaches the whole trusted-local surface. Reads only: a write there can
 *     restart or reconfigure the server.
 *   - The board's lead agent with its board token, the bearer an MCP call
 *     carries. Reads only, for the same reason.
 *   - A page in the owner's browser on this machine (`localhost`, a loopback
 *     peer, browser headers, no proof of any agent). Reads only. Alice's
 *     agent watches the board, so `/events/agent/<id>` would carry her
 *     private messages to anyone it let in.
 *
 * Each read is sent twice, bare and with a query naming both people, the
 * agent and a word of the message, so a search, an export or a filtered
 * feed is asked for exactly what it might leak. Each read also tries a
 * websocket upgrade at the same address. Every answer is read to its end;
 * a stream or socket is held open while Alice writes again, so a live
 * frame and a replayed one are both seen.
 *
 * Driven from the table, so a route added to it is called here without an
 * edit to this file. The positive control runs the same probe as Alice and
 * finds her own messages, so a probe that could not see a leak fails.
 *
 * The data folder is read last: each message is written to its own store
 * (and a message to an agent to that agent's mode-600 delivery queue).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { ROUTE_TABLE } from '../src/route-table-rows.ts';
import { exampleFor } from '../src/route-table.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import {
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { signedInPerson } from './signed-in-person.ts';
import { type FrameListener, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

/** Invented people on an invented domain, spelled at run time. */
const address = (name: string): string => `${name}@harborlight.example`;
const ALICE = address('alice');
const BOB = address('bob');
const RIVERBEND = address('riverbend');
const aliceId = emailIdentityId(ALICE);
const bobId = emailIdentityId(BOB);
const ALICE_AGENT = 'agent-harborlight-a1';
const LEAD = 'agent-saltmarsh-lead';
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BATCH = 16;

/** Unique words, so a hit can only be the message. */
const STORED_DM = 'quayside-7f3a-stored-direct';
const LIVE_DM = 'quayside-7f3a-live-direct';
const STORED_PM = 'quayside-7f3a-stored-private';
const LIVE_PM = 'quayside-7f3a-live-private';
const NEEDLES = [STORED_DM, LIVE_DM, STORED_PM, LIVE_PM];

type Send = (path: string, init?: RequestInit) => Promise<Response>;
interface Caller {
  name: string;
  send: Send;
  /** The websocket form of the same proof. */
  socket: (path: string) => { url: string; headers: Record<string, string> } | null;
  writes: boolean;
}

/** Everything one call returned, read until it ends or the test hangs up. */
interface Probe {
  label: string;
  text: () => string;
  /** Resolves when the answer ended by itself. */
  ended: Promise<void>;
  live: boolean;
  stop: () => Promise<void>;
}

function readAll(label: string, res: Response): Probe {
  const live = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  if (!res.body)
    return { label, text: () => '', ended: Promise.resolve(), live, stop: async () => {} };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const ended = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  return {
    label,
    text: () => text,
    ended,
    live,
    stop: async () => {
      await reader.cancel().catch(() => {});
      await ended;
    },
  };
}

function openSocket(label: string, url: string, headers: Record<string, string>): Probe {
  let text = '';
  let ended: () => void = () => {};
  const done = new Promise<void>((r) => {
    ended = r;
  });
  const decoder = new TextDecoder();
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (ev) => {
    text += typeof ev.data === 'string' ? ev.data : decoder.decode(new Uint8Array(ev.data));
  });
  ws.addEventListener('close', () => ended());
  ws.addEventListener('error', () => ended());
  return {
    label,
    text: () => text,
    ended: done,
    live: true,
    stop: async () => {
      ws.close();
    },
  };
}

describe('no route returns a private message between two other people', () => {
  let s: ShareProofServer;
  let docId = '';
  let taskId = '';
  let bobPage: FrameListener;
  let agentMux: FrameListener;
  let alicePerson: ReturnType<typeof signedInPerson>;
  const callers: Record<string, Caller> = {};
  const probes: Record<string, Probe[]> = {};
  const probed: Record<string, Set<string>> = {};

  const sendDm = async (text: string) => {
    const res = await s.visitor(ALICE, `${s.scope}/me/dm`, post({ to: bobId, text }));
    expect(res.status).toBe(200);
  };
  const sendPm = async (text: string) => {
    const res = await s.local('/api/me/messages', {
      ...post({ text }),
      headers: { 'content-type': 'application/json', ...alicePerson.headers },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  /** The row's example with this board's ids, once per person it can name. */
  const addressesFor = (pattern: string): string[] => {
    const people = pattern.includes(':personId') ? [aliceId, bobId] : [''];
    return people.map((person) =>
      exampleFor(pattern)
        .split('/')
        .map((seg, i) => {
          const name = pattern.split('/')[i] ?? '';
          const real: Record<string, string> = {
            ':ws': s.board,
            ':docId': encodeURIComponent(docId),
            ':taskId': taskId,
            ':personId': encodeURIComponent(person),
            ':agentId': ALICE_AGENT,
            ':agent': ALICE_AGENT,
          };
          return real[name] ?? seg;
        })
        .join('/'),
    );
  };
  const QUERY = `?${new URLSearchParams({
    with: bobId,
    person: aliceId,
    personId: bobId,
    agentId: ALICE_AGENT,
    q: 'quayside',
    format: 'json',
    archived: 'true',
    limit: '500',
  })}`;

  /** Call every row as `caller`, holding what each call returns. */
  async function probeAll(caller: Caller): Promise<void> {
    const calls: Array<() => Promise<Probe>> = [];
    const seen = new Set<string>();
    for (const row of ROUTE_TABLE) {
      seen.add(row.pattern);
      for (const path of addressesFor(row.pattern)) {
        for (const method of row.methods) {
          if (method === 'OPTIONS') continue;
          if (WRITES.has(method)) {
            if (!caller.writes) continue;
            calls.push(async () => {
              const res = await caller.send(path, {
                method,
                headers: { 'content-type': 'application/json' },
                body: '{}',
              });
              return readAll(`${method} ${path}`, res);
            });
            continue;
          }
          for (const at of [path, `${path}${QUERY}`]) {
            calls.push(async () =>
              readAll(
                `${method} ${at}`,
                await caller.send(at, { method, headers: { 'last-event-id': '0' } }),
              ),
            );
          }
          if (method === 'GET') {
            const sock = caller.socket(`${path}${QUERY}`);
            if (sock) calls.push(async () => openSocket(`WS ${path}`, sock.url, sock.headers));
          }
        }
      }
    }
    const out: Probe[] = [];
    for (let i = 0; i < calls.length; i += BATCH) {
      out.push(...(await Promise.all(calls.slice(i, i + BATCH).map((c) => c()))));
    }
    probes[caller.name] = out;
    probed[caller.name] = seen;
  }

  const hits = (name: string): string[] =>
    (probes[name] ?? [])
      .filter((p) => NEEDLES.some((n) => p.text().includes(n)))
      .map((p) => p.label.replace(s.board, ':ws').split('?')[0] ?? p.label);

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight');
    s.handle.shareLinks.addToAudience(s.board, [ALICE, BOB, RIVERBEND], 'Saltmarsh');
    for (const [email, name] of [
      [ALICE, 'Alice'],
      [BOB, 'Bob'],
      [RIVERBEND, 'Riverbend'],
    ] as const) {
      expect(await s.join(email)).toBe(302);
      s.handle.identities.upsertByEmail(email, { displayName: name });
    }
    for (const [agentId, agentName] of [
      [ALICE_AGENT, 'Harborlight'],
      [LEAD, 'Saltmarsh Lead'],
    ] as const) {
      s.handle.tasks.attachAgent(s.board, { agentId, agentName, runtime: 'claude-code-local' });
      s.handle.identities.upsertAgent(agentId, agentName);
    }
    s.handle.tasks.setLeadAgent(s.board, LEAD, {
      actor: { id: 'known-owner', name: 'Owner', kind: 'known' },
    });
    const filed = s.handle.tasks.createTask(s.board, {
      title: 'Harborlight survey',
      assignee: 'human',
      actor: { id: LEAD, name: 'Saltmarsh Lead', kind: 'agent' },
    });
    if (!filed.ok) throw new Error('task create refused');
    taskId = filed.task.id;
    const file = join(s.dataDir, 'saltmarsh.md');
    await Bun.write(file, '# Saltmarsh\n\nThe quay opens at dawn.\n');
    docId = (
      await readJson<{ docId: string }>(
        await s.local(`${s.scope}/docs`, post({ docId: 'saltmarsh', sourceUrl: file })),
      )
    ).docId;

    // Alice links her own lead agent, so she has a private conversation too.
    const host = `localhost:${s.handle.port}`;
    alicePerson = signedInPerson(s.handle, s.dataDir, host, { email: ALICE, name: 'Alice' });
    const at1 = mintAgentToken(ALICE_AGENT, agentTokenKey(loadCookieKey(s.dataDir)));
    expect(
      (
        await s.local('/api/auth/profile', {
          ...post({ leadAgentId: ALICE_AGENT }),
          headers: { 'content-type': 'application/json', ...alicePerson.headers },
        })
      ).status,
    ).toBe(200);
    const linked = await s.local(`/api/agents/${ALICE_AGENT}/person`, {
      ...post({ personId: aliceId }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1}` },
    });
    expect(await linked.json()).toMatchObject({ state: 'linked' });

    // Alice's agent watches the board, as an MCP child does, so every stream
    // keyed on that agent carries what is sent to it.
    const watched = await s.local(`/api/agents/${ALICE_AGENT}/watches`, {
      ...post({ add: [`ws:${s.board}`], name: 'Harborlight' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1}` },
    });
    expect(watched.status, await watched.clone().text()).toBe(200);
    // Her agent's own process, proven with its token: the positive control
    // for the page caller below.
    agentMux = listenFrames(
      await s.local(`/events/agent/${ALICE_AGENT}`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${at1}` },
      }),
    );

    await sendDm(`Bob, the tide table: ${STORED_DM}`);
    await sendPm(`A1, the tide table: ${STORED_PM}`);

    const sse = { headers: { accept: 'text/event-stream' } };
    bobPage = listenFrames(await s.visitor(BOB, `${s.scope}/me/events:stream`, sse));

    const port = s.handle.port;
    const leadToken = s.handle.boardTokens.mintHeld(LEAD, s.board).token;
    callers.riverbend = {
      name: 'riverbend',
      send: (path, init) => s.visitor(RIVERBEND, path, init),
      socket: () => null,
      writes: true,
    };
    callers.owner = {
      name: 'owner',
      send: (path, init) => s.owner(path, init),
      socket: () => null,
      writes: false,
    };
    callers.lead = {
      name: 'lead',
      send: (path, init) =>
        s.local(path, {
          ...init,
          headers: {
            ...((init?.headers as Record<string, string>) ?? {}),
            authorization: `Bearer ${leadToken}`,
          },
        }),
      socket: (path) => ({
        url: `ws://127.0.0.1:${port}${path}`,
        headers: { host: `localhost:${port}`, authorization: `Bearer ${leadToken}` },
      }),
      writes: false,
    };
    const page = { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' };
    callers.page = {
      name: 'page',
      send: (path, init) =>
        s.local(path, {
          ...init,
          headers: { ...((init?.headers as Record<string, string>) ?? {}), ...page },
        }),
      socket: (path) => ({
        url: `ws://127.0.0.1:${port}${path}`,
        headers: { host: `localhost:${port}`, ...page },
      }),
      writes: false,
    };
    callers.alice = {
      name: 'alice',
      send: (path, init) => s.visitor(ALICE, path, init),
      socket: () => null,
      writes: false,
    };
    for (const c of Object.values(callers)) await probeAll(c);

    // Written while every stream and socket above is open.
    await sendDm(`Bob, one more: ${LIVE_DM}`);
    await sendPm(`A1, one more: ${LIVE_PM}`);
    await waitFor(() => bobPage.frames.some((f) => JSON.stringify(f.data).includes(LIVE_DM)), {
      describe: "the live message on Bob's own stream",
    });
    // Each caller's own person stream is a later frame on the same server:
    // once Riverbend's sentinel lands, every write before it has been sent.
    const sentinel = 'Riverbend, a sentinel after both messages';
    expect(
      (
        await s.visitor(
          ALICE,
          `${s.scope}/me/dm`,
          post({ to: emailIdentityId(RIVERBEND), text: sentinel }),
        )
      ).status,
    ).toBe(200);
    await waitFor(
      () => (probes.riverbend ?? []).some((p) => p.live && p.text().includes(sentinel)),
      { describe: "the sentinel on Riverbend's own open stream" },
    );
    // Answers that end by themselves are read to their end.
    for (const list of Object.values(probes)) {
      await Promise.all(list.filter((p) => !p.live).map((p) => p.ended));
    }
  }, 120_000);

  afterAll(async () => {
    for (const list of Object.values(probes)) await Promise.all(list.map((p) => p.stop()));
    await bobPage?.stop();
    await agentMux?.stop();
    await s?.stop();
  });

  it('calls every row of the route table, for each caller', () => {
    const table = new Set(ROUTE_TABLE.map((r) => r.pattern));
    for (const name of ['riverbend', 'owner', 'lead', 'page']) {
      expect([...(probed[name] ?? [])].sort()).toEqual([...table].sort());
    }
    // Riverbend's read of her own stream is among the probes, and it is live.
    expect((probes.riverbend ?? []).some((p) => p.live)).toBe(true);
  });

  it('a board member, the owner, the lead agent and a local page read none of it', () => {
    expect(hits('riverbend')).toEqual([]);
    expect(hits('owner')).toEqual([]);
    expect(hits('lead')).toEqual([]);
    expect(hits('page')).toEqual([]);
  });

  it("refuses a page on this machine that opens an agent's own stream", async () => {
    const res = await callers.page?.send(`/events/agent/${ALICE_AGENT}`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: 'agent-stream-browser' });
  });

  it("the agent's own stream carries her private message to it (positive control)", async () => {
    await waitFor(() => agentMux.frames.some((f) => JSON.stringify(f.data).includes(LIVE_PM)), {
      describe: "the live private message on the agent's own stream",
    });
  });

  it("refuses a page that names an agent on the board's stream", async () => {
    const path = `${s.scope}/events:stream?agentId=${ALICE_AGENT}`;
    const res = await s.owner(path, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'agent-stream-browser' });
  });

  it('the same probe run as Alice finds her own messages (positive control)', () => {
    const found = new Set(hits('alice'));
    expect(found.has('GET /workspaces/:ws/me/dm')).toBe(true);
    expect(found.has('GET /workspaces/:ws/me/events:stream')).toBe(true);
    // Every place Alice reads them is one of her own two.
    expect([...found].filter((l) => !l.startsWith('GET /workspaces/:ws/me/'))).toEqual([]);
  });

  it('writes each message to its own store, and nowhere a member reads', () => {
    const holding = (needles: string[]): string[] => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (needles.some((n) => readFileSync(path, 'latin1').includes(n))) {
            files.push(relative(s.dataDir, path).replace(s.board, ':ws'));
          }
        }
      };
      walk(s.dataDir);
      return files.map((f) => f.replace(/\/[^/]+\.jsonl$/, '/'));
    };
    expect(holding([STORED_DM, LIVE_DM])).toEqual(['direct-messages/']);
    // A message to an agent also waits in that agent's delivery queue until
    // its session acknowledges it: mode 600, read by no route (above).
    expect(holding([STORED_PM, LIVE_PM]).sort()).toEqual([
      'private-messages/',
      'workspaces/:ws.comment-queue.json',
    ]);
    const queue = statSync(join(s.dataDir, 'workspaces', `${s.board}.comment-queue.json`));
    expect(queue.mode & 0o777).toBe(0o600);
  });
});
