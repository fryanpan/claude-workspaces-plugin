import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALL_ESCALATION_ACTOR, type TeamLeadReach } from '../src/stall-escalation.ts';
import { OWNER_UNFILED_BUCKET, type StalledRow } from '../src/stall-gate.ts';
import type { StallNudgeFrame, StallSnapshot } from '../src/stall-nudge.ts';
/**
 * The OTHER way onto the `unfiled` list ages up the same ladder.
 *
 * `stall-gate.ts` puts two findings on one list, because they have one
 * remedy: `waiting-unfiled` — the task's own agent said in its closing words
 * that it is waiting on a person — and `blocked-on-owner-unfiled`, where the
 * BOARD says a person owns the task and nothing is on that person's queue.
 * Different evidence, same failure: somebody is being waited on and cannot
 * see it.
 *
 * Only the first aged. `waitingUnfiledRows` filtered to one bucket, and
 * `stall-escalation.ts` — the other filer — fires only on a board where no
 * session is alive. So a board-declared unfiled ask on a LIVE board was told
 * to its lead every repeat window and went past nobody, however long the lead
 * ignored it. `stall-check/README.md`'s table gives one addressee chain for
 * "a task waits on a person and nothing is filed on that person's queue" and
 * does not split it by how the board came to know.
 *
 * Asserted here: the aging, and that the item's words say which kind each
 * task is rather than telling the reader an agent wrote something it did not.
 *
 * All fixtures are synthetic — invented names on made-up boards. The repo is
 * public.
 */
import { TaskStore } from '../src/tasks.ts';
import { WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const START = 10_000_000;

const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' as const };

describe('a board-declared unfiled ask ages past its lead too', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function boardWith(titles: readonly string[]): { store: TaskStore; ws: string; ids: string[] } {
    dir = dir || mkdtempSync(join(tmpdir(), 'owner-unfiled-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('release-train', { leadAgentId: LEAD.id }).id;
    const ids = titles.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Bryan can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error(`could not create ${title}`);
      return res.task.id;
    });
    return { store, ws, ids };
  }

  const snapshot = (ws: string, rows: readonly StalledRow[]): StallSnapshot => ({
    workspaceId: ws,
    leadAgentId: LEAD.id,
    retired: false,
    stalled: [],
    unfiled: rows,
    considered: rows.length,
    undetermined: [],
  });

  const row = (id: string, title: string, bucket: string): StalledRow => ({
    id,
    title,
    bucket,
    quietMs: 45 * MIN,
  });

  function serverItems(store: TaskStore, ws: string) {
    return store
      .listTasks(ws)
      .flatMap((t) => store.listReviewItems(t.id))
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name)
      .map((i) => i.review as { headline?: string; detail?: string });
  }

  it('is not escalated at one window and is at two', () => {
    const { store, ws, ids } = boardWith(['Pick the launch date']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [row(ids[0] as string, 'Pick the launch date', OWNER_UNFILED_BUCKET)];

    escalations.onTick([snapshot(ws, rows)], START);
    expect(escalations.filedCount()).toBe(0);
    // Control: inside the window, still nothing.
    escalations.onTick([snapshot(ws, rows)], START + WINDOW - MIN);
    expect(escalations.filedCount()).toBe(0);
    expect(serverItems(store, ws)).toHaveLength(0);

    escalations.onTick([snapshot(ws, rows)], START + WINDOW);
    expect(escalations.filedCount()).toBe(1);
    expect(serverItems(store, ws)).toHaveLength(1);
  });

  it('goes to Team Lead first, exactly as the other bucket does', () => {
    const { store, ws, ids } = boardWith(['Pick the launch date']);
    const sent: Array<{ agentId: string; frame: StallNudgeFrame }> = [];
    const teamLead: TeamLeadReach = {
      agentId: 'agent-team-lead',
      boards: () => [ws],
      canReach: () => true,
      send: (_ws, agentId, frame) => {
        sent.push({ agentId, frame });
        return 1;
      },
    };
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW, teamLead });
    const rows = [row(ids[0] as string, 'Pick the launch date', OWNER_UNFILED_BUCKET)];
    escalations.onTick([snapshot(ws, rows)], START);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW);

    expect(sent).toHaveLength(1);
    expect((sent[0]?.frame.unfiled ?? []).map((r) => r.bucket)).toEqual([OWNER_UNFILED_BUCKET]);
    // The owner's queue is untouched while Team Lead is reachable.
    expect(serverItems(store, ws)).toHaveLength(0);
  });

  it('names each task for the evidence it actually has', () => {
    // A mixed set is the case that catches a sentence written for one bucket
    // and applied to both: the reader must not be told an agent wrote closing
    // words about a task whose only evidence is the board's own ownership.
    const { store, ws, ids } = boardWith(['Pick the launch date', 'Cut the release branch']);
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: WINDOW });
    const rows = [
      row(ids[0] as string, 'Pick the launch date', OWNER_UNFILED_BUCKET),
      row(ids[1] as string, 'Cut the release branch', WAITING_UNFILED_BUCKET),
    ];
    escalations.onTick([snapshot(ws, rows)], START);
    escalations.onTick([snapshot(ws, rows)], START + WINDOW);

    const items = serverItems(store, ws);
    expect(items).toHaveLength(1);
    const detail = items[0]?.detail ?? '';
    // One line per task, each naming its own evidence.
    const owner = detail.split('\n').find((l) => l.includes(ids[0] as string)) ?? '';
    const agent = detail.split('\n').find((l) => l.includes(ids[1] as string)) ?? '';
    expect(owner).not.toContain('closing words');
    expect(owner.toLowerCase()).toContain('down to you');
    expect(agent.toLowerCase()).toContain('said it is waiting');
  });
});
