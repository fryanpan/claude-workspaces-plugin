/**
 * The ready-work wake on a board that is BUSY — the case it was silent for.
 *
 * The wake fires only after a board has been quiet for the idle window, and
 * that quiet was read from two clocks that disagreed. The in-process one
 * filters events through `isBoardActivity`, which excludes `task.noted`
 * because that is one event per TURN from every agent holding a row. The
 * durable one was `max(task.updatedAt)` across the board — and a turn-end note
 * bumps `updatedAt`. So the excluded event moved the clock through the other
 * half, and on any board with a working agent the window never elapsed. Not a
 * late wake: no wake, ever.
 *
 * What each test here drives, and why it is not the suite next door:
 * `ready-nudge-routes.test.ts` runs the whole pipe with `readyNudgeIdleMs: 0`,
 * where every board is idle the moment it is read — so a clock that never goes
 * quiet is invisible to it by construction. These tests give the window a real
 * length and ask what the clock says.
 *
 * The wake test assembles the snapshot from the same three calls
 * `stall-wiring.ts`'s `readyWorkSnapshot` makes — `buildQueue`,
 * `evaluateReadyWork`, `lastBoardActivityAt` — over a real `TaskStore` on an
 * injected clock. The one thing it does not borrow is the owner-kind probe,
 * which needs the doc projection and is not what is under test; the clock is.
 * The route test below covers the wiring that assembly cannot.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastBoardActivityAt } from '../src/board-activity.ts';
import { evaluateReadyWork } from '../src/ready-gate.ts';
import {
  type NudgeFrame,
  READY_IDLE_EVENT,
  ReadyWorkNudger,
  isBoardActivity,
} from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tasksSidecarPath } from '../src/task-persistence.ts';
import { buildQueue } from '../src/task-queue.ts';
import { TaskStore } from '../src/tasks.ts';
import { seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const h of servers.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A board with one ready agent-owned row, and one UNRELATED row a builder is
 * already holding — a different ticket, in a different state, that the ready
 * set never contains. That separation is the point: the note has to be
 * somebody else's turn ending, not an edit to the work being waited on.
 */
function board(dataDir: string, clock: () => number) {
  const store = new TaskStore({ dataDir, debounceMs: 5, now: clock });
  const workspaceId = store.createWorkspace('search-revamp', { leadAgentId: LEAD.id }).id;
  const goals = seedGoals(store, workspaceId, [{ key: 'rank', title: 'Rank results' }], PERSON);
  const held = store.createTask(workspaceId, {
    title: 'Rebuild the crawler queue',
    assignee: LEAD.name,
    goal: goals.rank as string,
    actor: PERSON,
  });
  if (!held.ok) throw new Error(`held row refused: ${held.error}`);
  const claimed = store.transition(held.task.id, 'in-progress', { actor: LEAD });
  if (!claimed.ok) throw new Error(`claim refused: ${claimed.error}`);
  const ready = store.createTask(workspaceId, {
    title: 'Rank results by recency',
    assignee: LEAD.name,
    goal: goals.rank as string,
    actor: PERSON,
  });
  if (!ready.ok) throw new Error(`ready row refused: ${ready.error}`);
  return { store, workspaceId, readyId: ready.task.id, heldId: held.task.id };
}

/** The three calls `readyWorkSnapshot` makes, over a real store. */
function snapshotOf(store: TaskStore, workspaceId: string) {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) throw new Error('no workspace');
  const tasks = store.listTasks(workspaceId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const verdict = evaluateReadyWork(
    buildQueue(tasks, workspace.goals, {
      includeBlocked: true,
      goalRows: store.listGoalRows(workspaceId),
    }),
    {
      ownerKind: (taskId) => (byId.get(taskId)?.assignee === LEAD.name ? 'agent' : 'person'),
      reviewState: (taskId) => {
        const state = store.reviewState(taskId);
        if (!state) throw new Error(`no such task: ${taskId}`);
        return state;
      },
    },
  );
  return {
    workspaceId,
    leadAgentId: LEAD.id,
    retired: false,
    ready: verdict.ready,
    considered: verdict.considered,
    held: verdict.held,
    undetermined: verdict.undetermined,
    lastActivityAt: lastBoardActivityAt(workspace, tasks),
  };
}

describe('a board a builder is working still gets its ready-work wake', () => {
  /**
   * Two hours of injected time, one tick a minute, a turn-end note on the
   * held row every five — comfortably inside the fifteen-minute window, which
   * is exactly the cadence the plugin's Stop hook produces.
   */
  it('fires once while turn-end notes land on an unrelated row', () => {
    // Anchored at the wall clock the store's own verbs stamp with, then
    // advanced: only the note follows the injected clock (`appendNote` is the
    // one verb that reads it), which is precisely the write under test.
    let clock = Date.now();
    const { store, workspaceId, readyId, heldId } = board(tmp('nudge-busy-'), () => clock);
    const frames: NudgeFrame[] = [];
    const nudger = new ReadyWorkNudger({
      snapshot: () => [snapshotOf(store, workspaceId)],
      lookup: () => snapshotOf(store, workspaceId),
      canReach: () => true,
      send: (_workspaceId, _agentId, frame) => {
        frames.push(frame);
        return 1;
      },
      now: () => clock,
      report: () => {},
    });
    store.onEvent((event) => {
      if (isBoardActivity(event.type)) nudger.noteActivity(event.workspaceId, event.ts);
    });

    expect(snapshotOf(store, workspaceId).ready.map((r) => r.id)).toEqual([readyId]);

    let notes = 0;
    for (let minute = 1; minute <= 120; minute++) {
      clock += 60_000;
      if (minute % 5 === 0) {
        const noted = store.appendNote(heldId, {
          kind: 'status',
          text: 'still on the crawler queue',
          agent: LEAD.name,
          ts: clock,
        });
        expect(noted.ok).toBe(true);
        notes += 1;
      }
      nudger.tick();
    }
    store.stop();

    // The notes really did land — a control, because "the wake fired" is also
    // what a board that received no notes at all would produce.
    expect(notes).toBe(24);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: READY_IDLE_EVENT, taskId: readyId, readyCount: 1 });
  });

  /** The same board with no notes at all — so the assertion above is about the
   *  notes rather than about the board happening to be wakeable. */
  it('fires once on the same board when nothing is noted', () => {
    let clock = Date.now();
    const { store, workspaceId, readyId } = board(tmp('nudge-quiet-'), () => clock);
    const frames: NudgeFrame[] = [];
    const nudger = new ReadyWorkNudger({
      snapshot: () => [snapshotOf(store, workspaceId)],
      lookup: () => snapshotOf(store, workspaceId),
      canReach: () => true,
      send: (_workspaceId, _agentId, frame) => {
        frames.push(frame);
        return 1;
      },
      now: () => clock,
      report: () => {},
    });
    for (let minute = 1; minute <= 120; minute++) {
      clock += 60_000;
      nudger.tick();
    }
    store.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: READY_IDLE_EVENT, taskId: readyId });
  });
});

describe('the durable idle clock', () => {
  it('does not move for a turn-end note, and does move for a real edit', async () => {
    const dataDir = tmp('nudge-clock-');
    const handle = createServer({ port: 0, dataDir });
    servers.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.ok, `${path} → ${res.status} ${await res.clone().text()}`).toBe(true);
      return res.json() as Promise<Record<string, never>>;
    };
    const { workspace } = (await post('/workspaces', {
      name: 'search-revamp',
      leadAgentId: LEAD.id,
    })) as unknown as { workspace: { id: string } };
    const workspaceId = workspace.id;
    const goals = await seedGoalsOverHttp(
      base,
      workspaceId,
      [{ key: 'rank', title: 'Rank results' }],
      PERSON,
    );
    const { task } = (await post(`/workspaces/${workspaceId}/tasks`, {
      title: 'Rebuild the crawler queue',
      assignee: LEAD.name,
      assigneeKind: 'agent',
      goal: goals.rank,
      author: PERSON,
    })) as unknown as { task: { id: string } };
    await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
      to: 'in-progress',
      author: LEAD,
      workspaceId,
    });

    const clockNow = (): number => {
      const ws = handle.tasks.getWorkspace(workspaceId);
      if (!ws) throw new Error('no workspace');
      return lastBoardActivityAt(ws, handle.tasks.listTasks(workspaceId));
    };
    const beforeNote = clockNow();
    expect(beforeNote).toBeGreaterThan(0);

    // The plugin's Stop hook, through the route it really posts to.
    const noted = await fetch(
      `${base}/workspaces/${workspaceId}/agents/${encodeURIComponent(LEAD.name)}/notes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'status', text: 'still on it', at: Date.now() }),
      },
    );
    expect(noted.status).toBe(202);
    // It landed on the row — otherwise "the clock did not move" would be
    // satisfied by a note that went nowhere.
    expect(handle.tasks.getTask(task.id)?.notes ?? []).toHaveLength(1);
    expect(clockNow()).toBe(beforeNote);

    // And a real edit still moves it, so the clock has not simply been frozen.
    await post(`/workspaces/${workspaceId}/tasks/${task.id}/title`, {
      title: 'Rebuild the crawler queue properly',
      author: PERSON,
      workspaceId,
    });
    expect(clockNow()).toBeGreaterThan(beforeNote);
  }, 60_000);

  /**
   * The durable half still carries real activity across a process boundary —
   * and carries the RIGHT reading, which is the half of this a fallback to the
   * old reduce would satisfy for free. So the board is left with a turn-end
   * note stamped a minute LATER than its last real edit: a restart that comes
   * back with the note's time is reading `max(updatedAt)` again, whatever the
   * stamp says.
   */
  it('survives a restart, and comes back with the edit rather than the note', () => {
    const dataDir = tmp('nudge-restart-');
    let clock = Date.now();
    const { store, workspaceId, heldId } = board(dataDir, () => clock);
    const renamed = store.renameTask(heldId, 'Rebuild the crawler queue properly', {
      actor: PERSON,
    });
    expect(renamed.ok).toBe(true);
    const reading = (s: TaskStore): number =>
      lastBoardActivityAt(
        s.getWorkspace(workspaceId) ??
          (() => {
            throw new Error('no workspace');
          })(),
        s.listTasks(workspaceId),
      );
    const afterEdit = reading(store);
    expect(afterEdit).toBeGreaterThan(0);

    // A minute later, somebody's turn ends. It moves `updatedAt` and must not
    // move this.
    clock += 60_000;
    expect(
      store.appendNote(heldId, {
        kind: 'status',
        text: 'still on the crawler queue',
        agent: LEAD.name,
        ts: clock,
      }).ok,
    ).toBe(true);
    const noteAt = store.getTask(heldId)?.updatedAt ?? 0;
    expect(noteAt).toBeGreaterThan(afterEdit);
    expect(reading(store)).toBe(afterEdit);
    store.flush();
    store.stop();

    const reopened = new TaskStore({ dataDir, debounceMs: 5 });
    expect(reopened.getWorkspace(workspaceId), 'the board should hydrate').toBeDefined();
    expect(reopened.getTask(heldId)?.updatedAt, 'the note should be on disk too').toBe(noteAt);
    expect(reading(reopened)).toBe(afterEdit);
    reopened.stop();
  });

  /**
   * The board that already exists — the one this was fixed for.
   *
   * Its sidecar was written before the field, and its only traffic is
   * turn-end notes, which never stamp it. So the seed has to happen at
   * hydrate: a board left to wait for its first admitted event would sit on
   * the contaminated reading for as long as somebody kept working it, which
   * is the defect surviving the fix on every board on disk.
   */
  it('seeds a pre-field board at hydrate, so notes cannot move it afterwards', () => {
    const dataDir = tmp('nudge-legacy-');
    let clock = Date.now();
    const { store, workspaceId, heldId } = board(dataDir, () => clock);
    store.flush();
    store.stop();

    // The sidecar as it was written before this field existed.
    const sidecar = tasksSidecarPath(dataDir, workspaceId);
    const saved = JSON.parse(readFileSync(sidecar, 'utf8')) as {
      workspace: Record<string, unknown>;
    };
    // `undefined` rather than `delete`: JSON.stringify drops the key either
    // way, and the assertion below reads the file back rather than trusting
    // that it did.
    saved.workspace.lastBoardActivityAt = undefined;
    writeFileSync(sidecar, `${JSON.stringify(saved, null, 2)}\n`);
    expect(
      Object.hasOwn(
        (JSON.parse(readFileSync(sidecar, 'utf8')) as { workspace: object }).workspace,
        'lastBoardActivityAt',
      ),
      'the fixture must be a sidecar written before the field',
    ).toBe(false);

    clock += 60_000;
    const reopened = new TaskStore({ dataDir, debounceMs: 5, now: () => clock });
    const workspace = reopened.getWorkspace(workspaceId);
    expect(workspace?.lastBoardActivityAt, 'hydrate should have seeded it').toBeGreaterThan(0);
    const seeded = lastBoardActivityAt(
      workspace ??
        (() => {
          throw new Error('no workspace');
        })(),
      reopened.listTasks(workspaceId),
    );

    // Now the only thing that happens to this board is somebody's turn ending.
    for (let turn = 0; turn < 5; turn++) {
      clock += 5 * 60_000;
      expect(
        reopened.appendNote(heldId, {
          kind: 'status',
          text: 'still on the crawler queue',
          agent: LEAD.name,
          ts: clock,
        }).ok,
      ).toBe(true);
    }
    expect(reopened.getTask(heldId)?.updatedAt).toBe(clock);
    expect(
      lastBoardActivityAt(
        reopened.getWorkspace(workspaceId) ??
          (() => {
            throw new Error('no workspace');
          })(),
        reopened.listTasks(workspaceId),
      ),
    ).toBe(seeded);
    reopened.stop();
  });
});
