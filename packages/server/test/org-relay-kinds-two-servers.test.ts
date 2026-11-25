/**
 * Team Lead on one server reaching a project lead on another through the
 * relay: a dispatch, a wake and a restart, over two real board servers.
 *
 * The Mac's server holds Team Lead's seat; the machine's server holds the
 * project lead's seat and a writer's. Both servers are in one organization,
 * as the Mac and the Fly machines are. Every seat posts with its own real
 * `at2`, and the relay reads and delivers with its own.
 *
 * What this proves: a dispatch and a wake land on the lead's inbox with the
 * kind and task id in the header, ADDRESSED to the lead, so a row waits on
 * its comment queue whether or not it watches the inbox; a restart from a
 * seat the lead's `restartFrom` does not name is refused and never reaches
 * the inbox; one from Team Lead lands as the one line the machine's check
 * reads, and `checkOnce` (`infra/project-machine/lead-restart.ts`) reading
 * that server answers `restart` once, and ignores the same line opened with
 * any token but the relay's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOnce } from '../../../infra/project-machine/lead-restart.ts';
import { type RelayConfig, parseRelayConfig } from '../src/org-relay/relay-config.ts';
import { createRelayStore } from '../src/org-relay/relay-log.ts';
import { createRelay } from '../src/org-relay/relay.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const RELAY_AGENT = 'agent-relay-harborlight';
const LEAD = 'agent-riverbend-lead';
const seatAgent = (id: string) => ({ id, name: id, kind: 'agent' });

interface ThreadRow {
  id: string;
  comments: Array<{ author: { id: string }; text: string; addressedTo?: Array<{ id: string }> }>;
}

describe('dispatch, wake and restart across two servers', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  let mac: ServerHandle;
  let machine: ServerHandle;
  let macBoard = '';
  let machineBoard = '';
  let config: RelayConfig;
  const tokens = new Map<string, string>();
  const base = (h: ServerHandle) => `http://127.0.0.1:${h.port}`;
  const post = async (h: ServerHandle, path: string, body: unknown, token?: string, want = 200) => {
    const res = await fetch(`${base(h)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(want);
    return (await res.json()) as Record<string, unknown>;
  };
  const handleOf = (server: string) => (server === 'mac' ? mac : machine);
  const seatOf = (id: string) => {
    const s = config.seats.get(id);
    if (!s) throw new Error(`no seat ${id}`);
    return s;
  };
  const send = async (seat: string, to: string, text: string) => {
    const s = seatOf(seat);
    await post(
      handleOf(s.server),
      `/workspaces/${s.board}/docs/${s.outboxDoc}/threads`,
      { author: seatAgent(s.agentId), text: `to: ${to}\n${text}`, anchor: { kind: 'subject' } },
      tokens.get(`${s.server}/${s.agentId}`),
    );
  };
  const threadsOn = async (h: ServerHandle, board: string, doc: string): Promise<ThreadRow[]> => {
    const res = await fetch(`${base(h)}/workspaces/${board}/docs/${doc}/threads`);
    return ((await res.json()) as { threads: ThreadRow[] }).threads;
  };
  const leadInbox = () => threadsOn(machine, machineBoard, seatOf('riverbend-lead').inboxDoc);
  const openers = async () => (await leadInbox()).map((t) => t.comments[0]?.text ?? '');
  const relay = () =>
    createRelay({
      config,
      store: createRelayStore(tmp('relay-state-')),
      filter: null,
      log: () => {},
    });
  const check = (stateFile: string) =>
    checkOnce({
      fetch: (path, init) => fetch(`${base(machine)}${path}`, init),
      boardId: machineBoard,
      inboxDoc: seatOf('riverbend-lead').inboxDoc,
      relayAgentId: RELAY_AGENT,
      ownAgentId: LEAD,
      stateFile,
      now: Date.now(),
    });

  beforeAll(async () => {
    mac = createServer({ port: 0, dataDir: tmp('relay-mac-') });
    machine = createServer({ port: 0, dataDir: tmp('relay-machine-') });
    const board = async (h: ServerHandle, name: string) =>
      (
        (await post(h, '/workspaces', { name, author: seatAgent('agent-setup') })) as {
          workspace: { id: string };
        }
      ).workspace.id;
    macBoard = await board(mac, 'Harborlight fleet');
    machineBoard = await board(machine, 'Riverbend project');
    const mint = async (server: string, b: string, agentId: string) => {
      const res = (await post(
        handleOf(server),
        '/api/board-tokens',
        { agentId, boardId: b, label: 'relay kinds test' },
        undefined,
        201,
      )) as { token: string };
      tokens.set(`${server}/${agentId}`, res.token);
      return res.token;
    };
    const task = async (h: ServerHandle, b: string, title: string) =>
      `task:${((await post(h, `/workspaces/${b}/tasks`, { title, author: seatAgent('agent-setup') })) as { task: { id: string } }).task.id}`;
    const seat = async (server: string, b: string, agentId: string, extra = {}) => {
      await mint(server, b, agentId);
      const h = handleOf(server);
      return {
        server,
        board: b,
        agentId,
        outboxDoc: await task(h, b, `Outbox for ${agentId}`),
        inboxDoc: await task(h, b, `Inbox for ${agentId}`),
        ...extra,
      };
    };
    // The lead is attached to its board, as a running lead is.
    await post(machine, `/workspaces/${machineBoard}/agents`, {
      agentId: LEAD,
      agentName: 'riverbend-lead',
      runtime: 'claude-code-local',
    });
    const parsed = parseRelayConfig(
      JSON.stringify({
        servers: {
          mac: {
            organization: 'harborlight',
            baseUrl: base(mac),
            bearers: { [macBoard]: await mint('mac', macBoard, RELAY_AGENT) },
          },
          machine: {
            organization: 'harborlight',
            baseUrl: base(machine),
            bearers: { [machineBoard]: await mint('machine', machineBoard, RELAY_AGENT) },
          },
        },
        seats: {
          'team-lead': await seat('mac', macBoard, 'agent-team-lead'),
          'riverbend-lead': await seat('machine', machineBoard, LEAD, {
            restartFrom: ['team-lead'],
          }),
          'riverbend-writer': await seat('machine', machineBoard, 'agent-riverbend-writer'),
        },
      }),
    );
    if ('error' in parsed) throw new Error(parsed.error);
    config = parsed;
  });

  afterAll(async () => {
    await mac?.stop();
    await machine?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('delivers a dispatch and a wake addressed to the lead, kind in the header', async () => {
    await send('team-lead', 'riverbend-lead', 'dispatch: t-harbor1\nThe export task is yours.');
    await send('team-lead', 'riverbend-lead', 'wake');
    await relay().pollOnce();
    const inbox = await leadInbox();
    const dispatch = inbox.find((t) => t.comments[0]?.text.startsWith('Relay dispatch'));
    expect(dispatch?.comments[0]?.text.split('\n')[0]).toStartWith(
      'Relay dispatch of task t-harbor1 from team-lead',
    );
    expect(dispatch?.comments[0]?.text).toContain('> The export task is yours.');
    expect(dispatch?.comments[0]?.addressedTo?.map((a) => a.id)).toEqual([LEAD]);
    expect(await openers()).toContain('Relay wake from team-lead, organization harborlight.');
    // Waiting for the lead on its queue, which it gets on its next attach.
    const queued = machine.tasks.listQueuedComments(machineBoard);
    expect(queued.some((r) => r.threadId === dispatch?.id && r.agentId === LEAD)).toBe(true);
  });

  it('refuses a restart from a seat the lead does not name, and delivers Team Lead’s', async () => {
    await send('riverbend-writer', 'riverbend-lead', 'restart-lead');
    await relay().pollOnce();
    const line = `Relay restart request from team-lead for ${LEAD}.`;
    // POSITIVE CONTROL for the absence below: the writer's outbox says why.
    const writerOutbox = await threadsOn(
      machine,
      machineBoard,
      seatOf('riverbend-writer').outboxDoc,
    );
    expect(writerOutbox.flatMap((t) => t.comments.map((c) => c.text))).toContain(
      'Relay: refused (restart-not-allowed).',
    );
    expect((await openers()).some((t) => t.startsWith('Relay restart request'))).toBe(false);

    await send('team-lead', 'riverbend-lead', 'restart-lead');
    await relay().pollOnce();
    const restart = (await leadInbox()).find((t) => t.comments[0]?.text === line);
    expect(restart).toBeDefined();
    // For the supervisor, not the session it ends.
    expect(restart?.comments[0]?.addressedTo).toBeUndefined();
  });

  it('tells the machine to restart once, and only for the relay’s own thread', async () => {
    const state = join(tmp('lead-root-'), 'restart-handled.json');
    expect(await check(state)).toBe('restart');
    expect(await check(state)).toBe('');

    // The same words, opened with the lead's own token: not the relay's.
    const inbox = seatOf('riverbend-lead').inboxDoc;
    await post(
      machine,
      `/workspaces/${machineBoard}/docs/${inbox}/threads`,
      {
        author: seatAgent(LEAD),
        text: `Relay restart request from team-lead for ${LEAD}.`,
        anchor: { kind: 'subject' },
      },
      tokens.get(`machine/${LEAD}`),
    );
    // Same state file, so the relay's thread is already handled: only the
    // new thread is a candidate, and it is not the relay's.
    expect(await check(state)).toBe('');
  });
});
