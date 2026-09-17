/**
 * Does a second in-progress row belonging to the same agent stop an
 * end-of-turn note reaching the store?
 *
 * The measurement that raised this (14-17 September, every board's own
 * `events.jsonl`): 335 turn notes, all from boards where one agent held one
 * or two in-progress rows. The boards where one agent held six and
 * twenty-five rows produced none for a fortnight while their `status` notes
 * kept arriving. That is a correlation; these cases are the experiment.
 *
 * Each claim is paired with the same note posted under one row, so a green
 * result cannot come from the harness refusing every note.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentNoteLogPath } from '../src/agent-note-log.ts';
import { localDay } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** A closing message that asks the owner something, so the same post
 *  exercises both halves: the durable note and the unfiled-ask judgement. */
const ASKING_TURN = 'Both arms are green. Want me to ship it tonight?';

describe('an end-of-turn note when the agent holds several in-progress rows', () => {
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
  const turnNote = (text: string) =>
    post(`/workspaces/${WS}/agents/cartographer/notes`, {
      agent: 'cartographer',
      kind: 'turn',
      text,
      at: Date.now(),
    });

  /** Every `task.noted` line the board's audit log holds, newest last. */
  const notedLines = (): string[] => {
    const path = join(dataDir, 'workspaces', `${WS}.events.jsonl`);
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    return raw.split('\n').filter((line) => line.includes('"event":"task.noted"'));
  };

  /** Every line the board's unplaced-note log holds, oldest first. */
  const unplacedLines = (): string[] => {
    let raw = '';
    try {
      raw = readFileSync(agentNoteLogPath(dataDir, WS), 'utf8');
    } catch {
      return [];
    }
    return raw.split('\n').filter((line) => line.trim() !== '');
  };

  /** Every note the store holds across the board's rows. */
  const storedNotes = (taskIds: string[]): string[] =>
    taskIds.flatMap((id) => (handle.tasks.getTask(id)?.notes ?? []).map((n) => n.text));

  const counted = () => handle.chatAudit.window(7, localDay(Date.now()));

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'turn-note-many-rows-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'turn-notes', leadAgentId: LEAD.id }),
    );
    WS = workspace.id;
    await jj(
      await post(`/workspaces/${WS}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' }),
    );
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A row the lead agent holds in-progress, the way a dispatch leaves it. */
  async function claimRow(title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${WS}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const to of ['todo', 'in-progress'] as const) {
      await jj(
        await post(`/workspaces/${WS}/tasks/${task.id}/transition`, {
          to,
          author: to === 'todo' ? PERSON : LEAD,
          workspaceId: WS,
        }),
      );
    }
    return task.id;
  }

  it('reaches the store when the agent holds ONE row (positive control)', async () => {
    const only = await claimRow('Wire the index');
    const r = await turnNote(ASKING_TURN);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, taskId: only });

    expect(storedNotes([only])).toEqual([ASKING_TURN]);
    expect(notedLines().filter((l) => l.includes('ship it tonight'))).toHaveLength(1);
  });

  it('lands on NO row once a second is held — the no-guess rule is unchanged', async () => {
    // Same agent, same board, same words — the only thing that changed is
    // that a second row is in-progress under the same claimant. The fix does
    // not place the note; it makes the unplaced note durable, so this half of
    // the behaviour has to stay exactly as it was.
    const first = await claimRow('Wire the index');
    const second = await claimRow('Rebuild the sidecar');

    const r = await turnNote(ASKING_TURN);
    expect(r.status).toBe(202);
    const body = (await r.json()) as { taskId?: string; needsFiling?: boolean };
    expect(body.taskId).toBeUndefined();
    expect(body.needsFiling).toBe(true);

    expect(storedNotes([first, second])).toEqual([]);
    expect(notedLines().filter((l) => l.includes('ship it tonight'))).toHaveLength(0);
  });

  it('survives a restart at two rows, where it used to exist only in the ring', async () => {
    // The defect this change ends. The ring is in-process, 20 deep and read by
    // nothing; a restart was the proof that an unplaced note went nowhere at
    // all. It now comes back off the board's unplaced-note log.
    await claimRow('Wire the index');
    await claimRow('Rebuild the sidecar');
    const posted = await turnNote(ASKING_TURN);
    expect(await posted.json()).toMatchObject({ logged: true, needsFiling: true });

    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { notes } = await jj<{ notes: Array<{ text: string; needsFiling?: boolean }> }>(
      await fetch(`${base}/workspaces/${WS}/agents/Cartographer/notes`),
    );
    expect(notes.map((n) => [n.text, n.needsFiling])).toEqual([[ASKING_TURN, true]]);
  });

  it('a placed note is NOT logged — the row is already its durable home', async () => {
    // The log is for what no row would take. Writing placed notes there too
    // would double every board's record and make its line count mean nothing.
    await claimRow('Wire the index');
    const r = await turnNote(ASKING_TURN);
    expect(await r.json()).not.toHaveProperty('logged');
    expect(unplacedLines()).toHaveLength(0);
  });

  it('logs the note with no row at all, not only the ambiguous one', async () => {
    // An agent holding nothing on this board is unplaced for a different
    // reason and was dropped just as completely. `needsFiling` marks the
    // ambiguous case only, so the log records which it was.
    await claimRow('Wire the index');
    const r = await post(`/workspaces/${WS}/agents/Nomad/notes`, {
      agent: 'Nomad',
      kind: 'turn',
      text: 'Compacted the transcript.',
      at: Date.now(),
    });
    expect(await r.json()).toMatchObject({ logged: true });
    const lines = unplacedLines().map(
      (l) => JSON.parse(l) as { agent: string; ambiguous: boolean },
    );
    expect(lines).toMatchObject([{ agent: 'Nomad', ambiguous: false }]);
  });

  it('still JUDGES the ask at two rows — only the durable note is lost', async () => {
    // The half of the brief's suspicion that does not hold. `judgeAndRecord`
    // runs before the row is resolved, so the unfiled-ask counter moves
    // whatever the row count is; what a many-row board loses is the note in
    // the Activity tab and the audit log, not the detector.
    await claimRow('Wire the index');
    await claimRow('Rebuild the sidecar');

    const r = await turnNote(ASKING_TURN);
    const body = (await r.json()) as { unfiledAsk?: string };
    expect(body.unfiledAsk).toContain('want me to');
    expect(counted().agents).toMatchObject([{ unfiledAsks: 1, totalAsks: 1 }]);
  });

  it('a status note is lost at two rows too — the kind is not what decides it', async () => {
    // The measurement showed `status` notes still arriving on the dark
    // boards. If ambiguity dropped statuses as well, the correlation would
    // have to have another cause; it does not, because `post_status` names
    // its row. This drives the SAME nameless route a status note takes when
    // nothing names a row.
    const first = await claimRow('Wire the index');
    const second = await claimRow('Rebuild the sidecar');
    const r = await post(`/workspaces/${WS}/agents/cartographer/notes`, {
      agent: 'cartographer',
      kind: 'status',
      text: 'Bundle is under budget at 41.2 KB.',
      at: Date.now(),
    });
    expect(r.status).toBe(202);
    expect(storedNotes([first, second])).toEqual([]);
  });
});
