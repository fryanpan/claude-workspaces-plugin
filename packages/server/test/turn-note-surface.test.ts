/**
 * Where a person meets an end-of-turn note no task took.
 *
 * `turn-note-many-rows.test.ts` proves such a note SURVIVES. These cases
 * prove it is READ: the board's `GET /workspaces/:ws/agent-notes` — the
 * source of Home's "Not on a task" list — hands it back under its agent with
 * the state it is in, and an open board page is told to re-read.
 *
 * Every case posts through the hook's own route and reads back through the
 * surface's route; the data files are opened only to prove an absence or the
 * control's store event. The one-task case is
 * the control: its note must land on the task exactly as before, and must
 * NOT appear on this surface.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentNoteLogPath } from '../src/agent-note-log.ts';
import type { AgentNotesView } from '../src/agent-note-placement.ts';
import { handleDispatchAndNoteRoutes } from '../src/routes/dispatch-and-notes.ts';
import type { TaskRoutesContext } from '../src/routes/task-routes-context.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'person' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const QUIET = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };

type Frame = { event: string; data?: Record<string, unknown> };

describe('the board surface for notes no task took', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;
  let WS = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const turn = (agent: string, text: string) =>
    post(`/workspaces/${WS}/agents/${agent}/notes`, { kind: 'turn', text, at: Date.now() });
  const surface = async (): Promise<AgentNotesView[]> =>
    (await jj<{ agents: AgentNotesView[] }>(await fetch(`${base}/workspaces/${WS}/agent-notes`)))
      .agents;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'turn-note-surface-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'turn-note-surface', leadAgentId: LEAD.id }),
    );
    WS = workspace.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A task held in progress by `holder`, the way a dispatch leaves it. */
  async function claim(title: string, holder = LEAD): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${WS}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: holder.name,
        assigneeKind: 'agent',
        author: holder,
      }),
    );
    for (const to of ['todo', 'in-progress'] as const) {
      await jj(
        await post(`/workspaces/${WS}/tasks/${task.id}/transition`, {
          to,
          author: to === 'todo' ? PERSON : holder,
          workspaceId: WS,
        }),
      );
    }
    return task.id;
  }

  const taskNotes = (id: string): string[] =>
    (handle.tasks.getTask(id)?.notes ?? []).map((n) => n.text);

  it('reads back a note from an agent holding SEVERAL tasks, named undecidable', async () => {
    const a = await claim('Wire the index');
    const b = await claim('Rebuild the sidecar');
    const r = await turn('Harborlight', 'Both arms green; merged the index half.');
    expect(await r.json()).toMatchObject({ placement: 'undecidable', logged: true });

    const agents = await surface();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agent: 'Harborlight', placement: 'undecidable' });
    expect(agents[0]?.notes.map((n) => n.text)).toEqual([
      'Both arms green; merged the index half.',
    ]);
    expect([...taskNotes(a), ...taskNotes(b)]).toEqual([]);
  });

  it('reads back a note from an agent holding NO task, named unattachable', async () => {
    // A peer's task on the same board is not this agent's.
    await claim('Wire the index');
    const r = await turn('Riverbend', 'Parked on the owner’s call about retention.');
    expect(await r.json()).toMatchObject({ placement: 'unattachable', logged: true });

    const agents = await surface();
    expect(agents.map((v) => [v.agent, v.placement])).toEqual([['Riverbend', 'unattachable']]);
    expect(agents[0]?.notes[0]?.text).toBe('Parked on the owner’s call about retention.');
  });

  it('tells the two apart when both are on the board at once', async () => {
    await claim('Wire the index');
    await claim('Rebuild the sidecar');
    await jj(await turn('Harborlight', 'could not pick'));
    await jj(await turn('Riverbend', 'nothing to pick'));
    const byAgent = Object.fromEntries((await surface()).map((v) => [v.agent, v.placement]));
    expect(byAgent).toEqual({ Harborlight: 'undecidable', Riverbend: 'unattachable' });
  });

  it('CONTROL: a note from an agent holding ONE task lands on it and stays off this surface', async () => {
    const only = await claim('Wire the index');
    const r = await turn('Harborlight', 'Wired the index.');
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, taskId: only, placement: 'attached' });
    expect(body).not.toHaveProperty('logged');
    expect(taskNotes(only)).toEqual(['Wired the index.']);
    const events = readFileSync(join(dataDir, 'workspaces', `${WS}.events.jsonl`), 'utf8');
    expect(events).toContain('"event":"task.noted"');
    expect(await surface()).toEqual([]);
  });

  it('shows a DECLARED withholding as its own state, with no words kept anywhere', async () => {
    const r = await post(`/workspaces/${WS}/agents/Saltmarsh/notes`, {
      withheld: true,
      at: Date.now(),
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ placement: 'withheld', logged: true });

    expect(await surface()).toMatchObject([
      { agent: 'Saltmarsh', placement: 'withheld', notes: [] },
    ]);
    // The per-agent read shows no empty note for it.
    const { notes } = await jj<{ notes: unknown[] }>(
      await fetch(`${base}/workspaces/${WS}/agents/Saltmarsh/notes`),
    );
    expect(notes).toEqual([]);
  });

  it('refuses the read to a share visitor, at the handler as well as the front door', async () => {
    // Driven at the handler: the front-door gate is pinned by the route
    // table's own tests, and this is the fence behind it. The member read is
    // the control: the same context answers 200.
    const url = `${base}/workspaces/${WS}/agent-notes`;
    const ask = (visitor: unknown) =>
      handleDispatchAndNoteRoutes(
        {
          agentNoteLog: { readBoard: () => [] },
          agentNotes: { list: () => [] },
          j: (status: number, body: unknown) => Response.json(body, { status }),
        } as unknown as TaskRoutesContext,
        {
          scope: { workspaceId: WS, rest: 'agent-notes', board: {} } as never,
          req: new Request(url),
          url: new URL(url),
          pathname: `/workspaces/${WS}/agent-notes`,
          visitor: visitor as never,
          authorFor: (() => undefined) as never,
        },
      );
    const refused = await ask({});
    expect(refused?.status).toBe(403);
    expect((await ask(null))?.status).toBe(200);
  });

  it('refuses a declaration carrying text, and keeps nothing', async () => {
    const r = await post(`/workspaces/${WS}/agents/Saltmarsh/notes`, {
      withheld: true,
      text: 'a sentence that must not land',
    });
    expect(r.status).toBe(400);
    let raw = '';
    try {
      raw = readFileSync(agentNoteLogPath(dataDir, WS), 'utf8');
    } catch {}
    expect(raw).not.toContain('must not land');
    expect(await surface()).toEqual([]);
  });

  it('says an agent is back on one task once a newer note lands there', async () => {
    const first = await claim('Wire the index');
    await claim('Rebuild the sidecar');
    await jj(await turn('Harborlight', 'Held two, so this went nowhere.'));
    await jj(
      await post(`/workspaces/${WS}/tasks/${first}/transition`, {
        to: 'done',
        author: LEAD,
        workspaceId: WS,
      }),
    );
    // A later `at`, so the order does not rest on two posts landing in distinct ms.
    await jj(
      await post(`/workspaces/${WS}/agents/Harborlight/notes`, {
        kind: 'turn',
        text: 'Down to one.',
        at: Date.now() + 1000,
      }),
    );
    const [view] = await surface();
    expect(view?.placement).toBe('attached');
    expect(view?.taskId).toBeDefined();
    expect(view?.notes.map((n) => n.text)).toEqual(['Held two, so this went nowhere.']);
  });

  it('pushes a wordless frame to an open board page, and to no agent’s stream', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${WS}/events:stream`, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    const frames = listen(res);
    // A bystander agent's own stream: a frame there would wake that session
    // about somebody else's turn.
    await jj(
      await post(`/workspaces/${WS}/agents`, { agentId: QUIET.id, runtime: 'claude-code-local' }),
    );
    const agentRes = await fetch(
      `${base}/workspaces/${WS}/events:stream?agentId=${encodeURIComponent(QUIET.id)}`,
      { headers: { accept: 'text/event-stream' }, signal: abort.signal },
    );
    const agentFrames = listen(agentRes);
    try {
      await jj(await turn('Riverbend', 'A sentence only the surface should carry.'));
      const frame = await waitFor(() => frames.find((f) => f.event === 'agent.noted'), {
        describe: 'an agent.noted frame on the board stream',
      });
      expect(frame.data).toEqual({ event: 'agent.noted', workspaceId: WS });
      // Positive control for the agent stream: a later board event reaches
      // it, and frames on one stream keep their order, so anything sent
      // before it would already be held.
      await claim('Chart the tide pools');
      await waitFor(() => agentFrames.find((f) => f.event === 'task.created'), {
        describe: 'a later board event on the agent stream',
      });
      expect(agentFrames.filter((f) => f.event === 'agent.noted')).toEqual([]);
    } finally {
      abort.abort();
    }
  });

  it('does not push that frame for a note that landed on a task', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/workspaces/${WS}/events:stream`, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    const frames = listen(res);
    try {
      await claim('Wire the index', QUIET);
      const placed = await jj<{ taskId?: string }>(await turn('Riverbend', 'Placed.'));
      expect(placed.taskId).toBeDefined();
      // The positive control that the stream delivers at all: a later
      // unplaced note's frame arrives, and it is the ONLY one — frames on one
      // stream keep their order, so the placed note before it pushed none.
      await jj(await turn('Harborlight', 'Holds nothing, so this one is unplaced.'));
      await waitFor(() => frames.find((f) => f.event === 'agent.noted'), {
        describe: 'the agent.noted frame for the later unplaced note',
      });
      expect(frames.filter((f) => f.event === 'agent.noted')).toHaveLength(1);
    } finally {
      abort.abort();
    }
  });
});

/** Frames off an SSE response, appended as they arrive. */
function listen(res: Response): Frame[] {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let sep = buf.indexOf('\n\n'); sep >= 0; sep = buf.indexOf('\n\n')) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const frame: Frame = { event: 'message' };
          for (const l of raw.split('\n')) {
            if (l.startsWith('event:')) frame.event = l.slice(6).trim();
            else if (l.startsWith('data:')) {
              try {
                frame.data = JSON.parse(l.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          frames.push(frame);
        }
      }
    } catch {}
  })();
  return frames;
}
