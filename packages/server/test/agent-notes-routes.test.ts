/**
 * Agent turn / denial notes over REST: the plugin's Stop and PermissionDenied
 * hooks post one-liners to `POST /workspaces/:ws/agents/:name/notes`, the server pins each to
 * the agent's CURRENT task (its latest in-progress claim) and exposes it on
 * the task's projected detail, newest first; a note from an agent holding no
 * task lands only in the per-agent ring buffer behind
 * `GET /workspaces/:ws/agents/:name/notes`.
 *
 * The server stores the text VERBATIM — the hook is what reduces a message
 * to a shape. The "secret-looking value survives" case below is the positive
 * control for that: a server that quietly filtered would pass every other
 * test here and still hide the fact from the hook's author.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_NOTE_RING_CAP,
  TASK_NOTES_READ_CAP,
  TASK_NOTES_STORE_CAP,
} from '../src/agent-notes.ts';
import { localDay } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceDocId } from '../src/task-projection.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

type ProjectedNote = { at: number; kind: string; text: string; agent: string };
type ProjectedTask = { id: string; notes?: ProjectedNote[] };
type RingNote = ProjectedNote & { taskId?: string; sessionId?: string; needsFiling?: boolean };

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('agent notes routes', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const notesPath = (agent: string) =>
    `/workspaces/${WS}/agents/${encodeURIComponent(agent)}/notes`;
  const note = (agent: string, text: string, extra: Record<string, unknown> = {}) =>
    post(notesPath(agent), { agent, kind: 'turn', text, at: Date.now(), ...extra });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-notes-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(name = 'search-revamp'): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name, leadAgentId: LEAD.id }),
    );
    WS = workspace.id;
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    WS = workspace.id;
    return WS;
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    return task.id;
  }

  function projected(workspaceId: string, taskId: string): ProjectedTask {
    const doc = handle.docStore.get(workspaceDocId(workspaceId));
    if (!doc) throw new Error('ws doc was not created');
    const row = doc.ydoc.getMap('tasks').get(taskId) as ProjectedTask | undefined;
    if (!row) throw new Error('task was not projected');
    return row;
  }

  const ring = async (agent: string) =>
    jj<{ notes: RingNote[] }>(await fetch(`${base}${notesPath(agent)}`));

  it('refuses a request from a host the server does not recognise', async () => {
    const r = await post(
      notesPath(LEAD.name),
      { agent: LEAD.name, kind: 'turn', text: 'Opened the PR' },
      { host: 'notes.attacker.example' },
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
    const g = await fetch(`${base}${notesPath(LEAD.name)}`, {
      headers: { host: 'notes.attacker.example' },
    });
    expect(g.status).toBe(403);
  });

  it('400s a malformed body and 405s the wrong method', async () => {
    // The URL names the agent now, so a missing or shared body `agent`
    // is no longer the body's fault — those two live in the address below.
    const bad: Array<[string, unknown]> = [
      ['not json', '{nope'],
      ['bad kind', { agent: 'Cartographer', kind: 'shout', text: 'x' }],
      ['missing text', { agent: 'Cartographer', kind: 'turn' }],
      ['empty text', { agent: 'Cartographer', kind: 'denial', text: '  ' }],
      ['non-string text', { agent: 'Cartographer', kind: 'turn', text: 42 }],
      ['non-numeric at', { agent: 'Cartographer', kind: 'turn', text: 'x', at: 'now' }],
    ];
    for (const [label, body] of bad) {
      const r = await post(notesPath('Cartographer'), body);
      expect(r.status, label).toBe(400);
    }
    expect((await fetch(`${base}${notesPath(LEAD.name)}`, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(`${base}${notesPath('agent')}`)).status).toBe(400);
    expect((await post(notesPath('agent'), { kind: 'turn', text: 'x' })).status).toBe(400);
    // A board that does not exist is 404 from the one middleware, never a
    // note written anywhere.
    expect(
      (await post('/workspaces/w-gone/agents/Cartographer/notes', { kind: 'turn', text: 'x' }))
        .status,
    ).toBe(404);
  });

  it('pins a note to the agent’s current task and projects it newest first', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    const first = await note(LEAD.name, 'Read the scout digest', { sessionId: 'sess-1' });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, taskId, workspaceId: wsId });
    const second = await post(notesPath(LEAD.name), {
      agent: LEAD.name,
      kind: 'denial',
      text: 'git rm',
      sessionId: 'sess-1',
      cwd: '/somewhere/private',
    });
    expect(second.status).toBe(202);
    await settle();

    // The store: append order, the raw session id kept for the pane.
    const stored = handle.tasks.getTask(taskId);
    expect(stored?.notes?.map((n) => [n.kind, n.text, n.agent, n.sessionId])).toEqual([
      ['turn', 'Read the scout digest', LEAD.name, 'sess-1'],
      ['denial', 'git rm', LEAD.name, 'sess-1'],
    ]);
    // Host paths are not workspace content.
    expect(JSON.stringify(stored?.notes)).not.toContain('/somewhere/private');

    // The board's read: newest first, no session id, no host path.
    const row = projected(wsId, taskId);
    expect(row.notes?.map((n) => [n.kind, n.text, n.agent])).toEqual([
      ['denial', 'git rm', LEAD.name],
      ['turn', 'Read the scout digest', LEAD.name],
    ]);
    expect(JSON.stringify(row.notes)).not.toContain('sess-1');
    expect(JSON.stringify(row.notes)).not.toContain('/somewhere/private');

    // The audit trail carries it as an event of its own.
    const log = await Bun.file(join(dataDir, 'workspaces', `${wsId}.events.jsonl`)).text();
    expect(log).toContain('"event":"task.noted"');
    expect(log).toContain('Read the scout digest');
  });

  it('tells the agent, in the 202, that it ended a turn asking with nothing filed', async () => {
    // The 202 body is the only channel back to the session that posted: the
    // hook turns a non-empty `unfiledAsk` into a Stop-hook block, which is
    // what "told within the turn" means.
    const wsId = await boardWithLead();
    await inProgressRow(wsId, 'Only claim');
    const r = await note('cartographer', 'Both arms are green. Want me to ship it tonight?');
    expect(r.status).toBe(202);
    const body = (await r.json()) as { unfiledAsk?: string };
    expect(body.unfiledAsk).toContain('want me to');

    // And the count behind the board's number moved by exactly one ask.
    const audit = handle.chatAudit.window(7, localDay(Date.now()));
    expect(audit.agents).toMatchObject([{ unfiledAsks: 1, totalAsks: 1, days: 1 }]);
  });

  it('says nothing when the turn asked nothing', async () => {
    const wsId = await boardWithLead();
    await inProgressRow(wsId, 'Only claim');
    const r = await note('cartographer', 'Both arms are green. Pushed the branch.');
    expect(await r.json()).not.toHaveProperty('unfiledAsk');
    // A turn with no ask in it is not a row in the count either — otherwise
    // the denominator would be "turns", and the number would mean nothing.
    expect(handle.chatAudit.window(7, localDay(Date.now())).agents).toEqual([]);
  });

  it('says nothing when the same agent already has an open item on the board', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Only claim');
    const added = handle.tasks.addReviewItem(
      taskId,
      {
        shape: 'decision',
        headline: 'Ship tonight or hold for the morning?',
        detail: 'Both arms are green; the only question is whether tonight is a good night.',
        options: [
          { id: 'o-1a2b', label: 'Tonight' },
          { id: 'o-3c4d', label: 'Morning' },
        ],
      },
      { actor: LEAD },
    );
    expect(added.ok).toBe(true);
    const r = await note('cartographer', 'Both arms are green. Want me to ship it tonight?');
    expect(await r.json()).not.toHaveProperty('unfiledAsk');
    // Still an ask — it is counted, and counted as a FILED one.
    expect(handle.chatAudit.window(7, localDay(Date.now())).agents).toMatchObject([
      { unfiledAsks: 0, totalAsks: 1, days: 1 },
    ]);
  });

  it('refuses to guess between two in-progress rows: the note goes to the ring, marked needs-filing', async () => {
    // A 2-week replay of prod notes (2026-08-31) found 93% of automatic notes
    // faced 2+ candidate rows, and a judged sample put the newest-claim guess
    // wrong ~3 times in 4. Ambiguity now files nowhere rather than wrongly.
    const wsId = await boardWithLead();
    const older = await inProgressRow(wsId, 'Older claim');
    await settle(5);
    const newer = await inProgressRow(wsId, 'Newer claim');

    // A lowercase spelling still resolves through the claim transition's
    // actor id, not the verbatim assignee string.
    const r = await note('cartographer', 'Pushed the branch');
    expect(r.status).toBe(202);
    const body = (await r.json()) as { taskId?: string; needsFiling?: boolean };
    expect(body.taskId).toBeUndefined();
    expect(body.needsFiling).toBe(true);
    await settle();
    expect(handle.tasks.getTask(newer)?.notes ?? []).toHaveLength(0);
    expect(handle.tasks.getTask(older)?.notes ?? []).toHaveLength(0);
    const { notes } = await ring(LEAD.name);
    expect(notes.map((n) => [n.text, n.taskId, n.needsFiling])).toEqual([
      ['Pushed the branch', undefined, true],
    ]);
  });

  it('one candidate row is not a guess: the note still lands there, folding the name', async () => {
    const wsId = await boardWithLead();
    const only = await inProgressRow(wsId, 'Only claim');
    const r = await note('cartographer', 'Pushed the branch');
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ taskId: only });
    await settle();
    expect(projected(wsId, only).notes?.map((n) => n.text)).toEqual(['Pushed the branch']);
    const { notes } = await ring(LEAD.name);
    expect(notes[0]?.needsFiling).toBeUndefined();
  });

  it('an explicit taskId on the hook route addresses the row, beating ambiguity', async () => {
    const wsId = await boardWithLead();
    const older = await inProgressRow(wsId, 'Older claim');
    await settle(5);
    const newer = await inProgressRow(wsId, 'Newer claim');
    const r = await note(LEAD.name, 'About the older row', { taskId: older });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ taskId: older, workspaceId: wsId });
    await settle();
    expect(handle.tasks.getTask(older)?.notes?.map((n) => n.text)).toEqual(['About the older row']);
    expect(handle.tasks.getTask(newer)?.notes ?? []).toHaveLength(0);
    // An address that names nothing is a caller error, not a silent ring drop.
    // Shaped unlike a real row id on purpose — the leak gate flags those.
    const bad = await note(LEAD.name, 'Lost letter', { taskId: 't-nope' });
    expect(bad.status).toBe(404);
  });

  it('the latest claimant wins over the stored assignee on a handed-over row', async () => {
    const OTHER = { id: 'agent-nomad', name: 'Nomad', kind: 'agent' };
    const wsId = await boardWithLead();
    await post(`/workspaces/${wsId}/agents`, {
      agentId: OTHER.id,
      runtime: 'claude-code-local',
    });
    // Assigned to the lead, but Nomad is the one who took it in-progress.
    const handed = await inProgressRow(wsId, 'Handed over');
    await jj(
      await post(`/workspaces/${wsId}/tasks/${handed}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId: wsId,
      }),
    );
    await jj(
      await post(`/workspaces/${wsId}/tasks/${handed}/transition`, {
        to: 'in-progress',
        author: OTHER,
        workspaceId: wsId,
      }),
    );

    const mine = await note(OTHER.name, 'Nomad is on it');
    expect(await mine.json()).toMatchObject({ taskId: handed });
    const theirs = await note(LEAD.name, 'Lead is elsewhere');
    const body = (await theirs.json()) as { taskId?: string };
    expect(body.taskId).toBeUndefined();
    await settle();
    expect(handle.tasks.getTask(handed)?.notes?.map((n) => n.text)).toEqual(['Nomad is on it']);
  });

  it('a person moving the row in-progress leaves it with its assignee (positive control)', async () => {
    const wsId = await boardWithLead();
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${wsId}/tasks`, {
        title: 'Moved by a person',
        body: 'Agent can pick this up so that the queue keeps moving.',
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: PERSON,
      }),
    );
    // A person-filed row is already `todo`; the person moves it in-progress.
    await jj(
      await post(`/workspaces/${wsId}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: PERSON,
        workspaceId: wsId,
      }),
    );
    const r = await note(LEAD.name, 'Picked it up');
    expect(await r.json()).toMatchObject({ taskId: task.id });
  });

  it('keeps a note from an agent with no current task in the per-agent ring only', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Someone else’s row');

    const r = await note('Nomad', 'Compacted the transcript', { sessionId: 'sess-9' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { ok: boolean; taskId?: string };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeUndefined();
    await settle();
    expect(handle.tasks.getTask(taskId)?.notes ?? []).toHaveLength(0);

    const { notes } = await ring('Nomad');
    // The GET read omits sessionId, same as the task-projection read does —
    // a session id is not workspace content either way.
    expect(notes.map((n) => [n.kind, n.text, n.agent, n.sessionId, n.taskId])).toEqual([
      ['turn', 'Compacted the transcript', 'Nomad', undefined, undefined],
    ]);
    // Name folding on the read side too, and an unknown agent is an empty list.
    expect((await ring('nomad')).notes).toHaveLength(1);
    expect((await ring('Nobody')).notes).toEqual([]);
  });

  it('the ring also carries task-bound notes, tagged with the task, so the pane has one read', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    await note(LEAD.name, 'Bound note');
    const { notes } = await ring(LEAD.name);
    expect(notes.map((n) => [n.text, n.taskId])).toEqual([['Bound note', taskId]]);
  });

  it('caps the ring at the newest entries, newest first', async () => {
    for (let i = 1; i <= AGENT_NOTE_RING_CAP + 5; i++) {
      expect((await note('Nomad', `turn ${i}`)).status).toBe(202);
    }
    const { notes } = await ring('Nomad');
    expect(notes).toHaveLength(AGENT_NOTE_RING_CAP);
    expect(notes[0]?.text).toBe(`turn ${AGENT_NOTE_RING_CAP + 5}`);
    expect(notes.at(-1)?.text).toBe('turn 6');
  });

  it('projects the newest notes only, and bounds what the sidecar keeps', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Long-running row');
    const total = TASK_NOTES_STORE_CAP + 3;
    for (let i = 1; i <= total; i++) {
      expect((await note(LEAD.name, `turn ${i}`)).status).toBe(202);
    }
    await settle();
    const stored = handle.tasks.getTask(taskId)?.notes ?? [];
    expect(stored).toHaveLength(TASK_NOTES_STORE_CAP);
    expect(stored[0]?.text).toBe('turn 4');
    expect(stored.at(-1)?.text).toBe(`turn ${total}`);

    const row = projected(wsId, taskId);
    expect(row.notes).toHaveLength(TASK_NOTES_READ_CAP);
    expect(row.notes?.[0]?.text).toBe(`turn ${total}`);
    expect(row.notes?.at(-1)?.text).toBe(`turn ${total - TASK_NOTES_READ_CAP + 1}`);
  });

  it('stores the text verbatim — a secret-looking value is the hook’s job to keep out', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    // Synthetic: this is the SHAPE of a leak, not a credential.
    const leaky = 'set token to sk-test-FAKE0000000000000000';
    expect((await note(LEAD.name, leaky)).status).toBe(202);
    expect((await note('Nomad', leaky)).status).toBe(202);
    await settle();
    expect(handle.tasks.getTask(taskId)?.notes?.[0]?.text).toBe(leaky);
    expect(projected(wsId, taskId).notes?.[0]?.text).toBe(leaky);
    expect((await ring('Nomad')).notes[0]?.text).toBe(leaky);
  });

  it('a note never reaches another agent’s workspace stream — projection and audit still see it', async () => {
    // Every store event rides `ws~<id>`, and an attached MCP child relays any
    // task.* frame it has no line for as a channel message. Broadcasting
    // task.noted would therefore wake every other agent on the board once per
    // turn of this one — and two agents each holding a row wake each other
    // forever. The stream must stay silent for it; the ydoc projection and
    // the audit log are the readers.
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    const stream = await fetch(`${base}/workspaces/${wsId}/events:stream?agentId=agent-other`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(stream.status).toBe(200);
    await settle();
    const heard: string[] = [];
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const line of decoder.decode(value).split('\n')) {
            if (line.startsWith('event: ')) heard.push(line.slice(7).trim());
          }
        }
      } catch {}
    })();

    expect((await note(LEAD.name, 'Quiet on the wire')).status).toBe(202);
    // Positive control on the same stream: a row moving IS broadcast.
    await jj(
      await post(`/workspaces/${WS}/tasks/${taskId}/transition`, {
        to: 'done',
        author: LEAD,
        workspaceId: wsId,
      }),
    );
    await settle(400);
    void reader.cancel().catch(() => {});

    expect(heard).toContain('task.transitioned');
    expect(heard).not.toContain('task.noted');
    expect(projected(wsId, taskId).notes?.map((n) => n.text)).toEqual(['Quiet on the wire']);
    const log = await Bun.file(join(dataDir, 'workspaces', `${wsId}.events.jsonl`)).text();
    expect(log).toContain('"event":"task.noted"');
  });

  it('task notes survive a restart; the ring does not', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    await note(LEAD.name, 'Before the restart');
    await note('Nomad', 'Ephemeral');
    await handle.stop();

    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    expect(handle.tasks.getTask(taskId)?.notes?.map((n) => n.text)).toEqual(['Before the restart']);
    expect(projected(wsId, taskId).notes?.map((n) => n.text)).toEqual(['Before the restart']);
    expect((await ring('Nomad')).notes).toEqual([]);
  });
});
