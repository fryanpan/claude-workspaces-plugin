/**
 * Where a person meets an end-of-turn note no task took.
 *
 * `turn-note-many-rows.test.ts` proves such a note SURVIVES. These cases
 * prove it is READ: `GET /workspaces/:ws/agent-notes` — the source of Home's
 * "Not on a task" list — hands it back under its agent with the state it is
 * in, and an open board page is told to re-read.
 *
 * Every case posts through the hook's own route and reads back through the
 * surface's route. The one-task case is the control: its note must land on
 * the task exactly as before, and must NOT appear on this surface.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentNoteLog } from '../src/agent-note-log.ts';
import type { AgentNotesView } from '../src/agent-note-placement.ts';
import { handleBoardAgentNotesRoutes } from '../src/routes/board-agent-notes.ts';
import type { RouteRow } from '../src/routes/row-dispatch.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const QUIET = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };

type Frame = { event: string; data?: Record<string, unknown> };

describe('GET /workspaces/:ws/agent-notes — the notes no task took', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;
  let access: AccessHarness;
  let WS = '';
  let PERSON: { id: string; name: string } = { id: '', name: 'Alice' };
  let proof: Record<string, string> = {};

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...((body as { author?: { id?: string } })?.author?.id === PERSON.id ? proof : {}),
      },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const turn = (agent: string, text: string, at = Date.now()) =>
    post(`/workspaces/${WS}/agents/${agent}/notes`, { kind: 'turn', text, at });
  const surface = async (): Promise<AgentNotesView[]> =>
    (await jj<{ agents: AgentNotesView[] }>(await fetch(`${base}/workspaces/${WS}/agent-notes`)))
      .agents;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-agent-notes-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const signed = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    PERSON = signed.user;
    proof = signed.headers;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'board-agent-notes', leadAgentId: LEAD.id }),
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

  it('reads back a note from an agent holding SEVERAL tasks as undecidable', async () => {
    const a = await claim('Wire the index');
    const b = await claim('Rebuild the sidecar');
    expect(await jj(await turn('Harborlight', 'Both arms green.'))).toMatchObject({
      logged: true,
    });
    const agents = await surface();
    expect(agents.map((v) => [v.agent, v.placement])).toEqual([['Harborlight', 'undecidable']]);
    expect(agents[0]?.notes.map((n) => n.text)).toEqual(['Both arms green.']);
    expect([...taskNotes(a), ...taskNotes(b)]).toEqual([]);
  });

  it('reads back a note from an agent holding NO task as unattachable', async () => {
    // A peer's task on the same board is not this agent's.
    await claim('Wire the index');
    await jj(await turn('Riverbend', 'Parked on the retention call.'));
    const agents = await surface();
    expect(agents.map((v) => [v.agent, v.placement])).toEqual([['Riverbend', 'unattachable']]);
    expect(agents[0]?.notes[0]?.text).toBe('Parked on the retention call.');
  });

  it('tells the two apart when both are on the board at once', async () => {
    await claim('Wire the index');
    await claim('Rebuild the sidecar');
    await jj(await turn('Harborlight', 'could not pick'));
    await jj(await turn('Riverbend', 'nothing to pick'));
    const byAgent = Object.fromEntries((await surface()).map((v) => [v.agent, v.placement]));
    expect(byAgent).toEqual({ Harborlight: 'undecidable', Riverbend: 'unattachable' });
  });

  it('CONTROL: a note from an agent holding ONE task lands on it and stays off this list', async () => {
    const only = await claim('Wire the index');
    const body = await jj<Record<string, unknown>>(await turn('Harborlight', 'Wired the index.'));
    expect(body).toMatchObject({ ok: true, taskId: only });
    expect(body).not.toHaveProperty('logged');
    expect(taskNotes(only)).toEqual(['Wired the index.']);
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
    // A later `at`, so the order does not rest on two posts in distinct ms.
    await jj(await turn('Harborlight', 'Down to one.', Date.now() + 1000));
    const [view] = await surface();
    expect(view?.placement).toBe('attached');
    expect(view?.taskId).toBeDefined();
    expect(view?.notes.map((n) => n.text)).toEqual(['Held two, so this went nowhere.']);
  });

  it('refuses a share visitor, while the board page still serves them', async () => {
    await jj(await turn('Riverbend', 'A sentence only members read.'));
    const visitor = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, WS, {
      label: 'board share',
    });
    // Presence: the visitor's credentials DO reach the board page.
    expect((await fetch(`${base}/workspaces/${WS}`, { headers: visitor.headers })).status).toBe(
      200,
    );
    const denied = await fetch(`${base}/workspaces/${WS}/agent-notes`, {
      headers: visitor.headers,
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('only members read');
  });

  it('refuses a share visitor at the handler too, behind the front door', async () => {
    const url = `${base}/workspaces/${WS}/agent-notes`;
    const row: RouteRow = { pattern: '/workspaces/:ws/agent-notes', params: { ws: WS } };
    const ask = (visitor: unknown) =>
      handleBoardAgentNotesRoutes(
        {
          agentNoteLog: {
            readBoard: () => ({ lines: [], skipped: new Map() }),
          } as unknown as AgentNoteLog,
          agentNotes: { list: () => [] },
          j: (status: number, body: unknown) => Response.json(body, { status }),
        },
        {
          scope: { workspaceId: WS, rest: 'agent-notes', board: {} } as never,
          req: new Request(url),
          row,
          visitor: visitor as never,
        },
      );
    expect((await ask({}))?.status).toBe(403);
    // The member read is the control: the same context answers 200.
    expect((await ask(null))?.status).toBe(200);
  });

  it('pushes a wordless frame to an open board page, and to no agent’s stream', async () => {
    const abort = new AbortController();
    const page = listen(
      await fetch(`${base}/workspaces/${WS}/events:stream`, {
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      }),
    );
    // A bystander agent's own stream: a frame there would wake that session
    // about somebody else's turn.
    await jj(
      await post(`/workspaces/${WS}/agents`, { agentId: QUIET.id, runtime: 'claude-code-local' }),
    );
    const agent = listen(
      await fetch(`${base}/workspaces/${WS}/events:stream?agentId=${QUIET.id}`, {
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      }),
    );
    try {
      await jj(await turn('Riverbend', 'A sentence only the list should carry.'));
      const frame = await waitFor(() => page.find((f) => f.event === 'agent.noted'), {
        describe: 'an agent.noted frame on the board stream',
      });
      expect(frame.data).toEqual({ event: 'agent.noted', workspaceId: WS });
      // Positive control for the agent stream: a later board event reaches
      // it, and frames on one stream keep their order, so anything sent
      // before it would already be held.
      await claim('Chart the tide pools');
      await waitFor(() => agent.find((f) => f.event === 'task.created'), {
        describe: 'a later board event on the agent stream',
      });
      expect(agent.filter((f) => f.event === 'agent.noted')).toEqual([]);
    } finally {
      abort.abort();
    }
  });

  it('pushes a frame for a note that landed on a task, so Home can say where it went', async () => {
    const abort = new AbortController();
    const page = listen(
      await fetch(`${base}/workspaces/${WS}/events:stream`, {
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      }),
    );
    try {
      await claim('Wire the index', QUIET);
      expect(await jj<{ taskId?: string }>(await turn('Riverbend', 'Placed.'))).toHaveProperty(
        'taskId',
      );
      // An agent that held several tasks and now holds one: an open Home's
      // header names the task it went to only if it is told to re-read.
      const frame = await waitFor(() => page.find((f) => f.event === 'agent.noted'), {
        describe: 'an agent.noted frame for the placed note',
      });
      expect(frame.data).toEqual({ event: 'agent.noted', workspaceId: WS });
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
