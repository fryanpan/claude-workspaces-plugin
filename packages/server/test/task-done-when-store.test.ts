/**
 * `TaskDoneWhenStore` driven directly, per testing-standards rule 4 — the
 * three verbs and the auto-close, without a `TaskStore` under them.
 *
 * The properties here are the ones the contract is stated against and that a
 * route test reaches only incidentally: a report is validated WHOLE before
 * anything is written, a person's `met` needs no proof while an agent's does,
 * the close goes through the ordinary transition gate and reports `false`
 * when that gate refuses, and a list edit that removes the last open line
 * closes the task exactly as a report would.
 *
 * The fake is local rather than `task-verb-harness.ts`'s, because this
 * module's persistence is the only one of the family that moves a row and
 * pins a note, and the harness's `transition` records a move to `todo`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import {
  type DoneWhenActor,
  TaskDoneWhenStore,
  buildDoneWhenLines,
  parseDoneWhenInput,
} from '../src/task-done-when.ts';

const PERSON: DoneWhenActor = { id: 'known-bryan', name: 'Bryan', kind: 'person' };
const AGENT: DoneWhenActor = { id: 'a-harborlight', name: 'Harborlight', kind: 'agent' };

function makeTask(doneWhen?: DoneWhenLine[]): Task {
  return {
    id: 't-1',
    workspaceId: 'ws-1',
    title: 'A task',
    assignee: 'Harborlight',
    goal: 'g-1',
    order: 1,
    status: 'in-progress',
    after: [],
    links: [],
    transitions: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(doneWhen !== undefined ? { doneWhen } : {}),
  } as Task;
}

/** Everything the verbs reach, plus the recording a test reads back. */
function fake(task: Task, opts: { transitionOk?: boolean } = {}) {
  const saved: string[] = [];
  const moves: Array<{ taskId: string; to: string }> = [];
  const notes: string[] = [];
  const store = new TaskDoneWhenStore({
    getTask: (id) => (id === task.id ? task : undefined),
    scheduleSave: (id) => {
      saved.push(id);
    },
    transition: (taskId, to) => {
      const ok = opts.transitionOk !== false;
      if (ok) {
        moves.push({ taskId, to });
        task.status = 'done';
      }
      return { ok };
    },
    appendNote: (_taskId, input) => {
      notes.push(input.text);
      return undefined;
    },
  });
  return { store, saved, moves, notes };
}

/** Lines with known ids, so a test can address one. */
function lines(...texts: string[]): DoneWhenLine[] {
  return texts.map((text, i) => ({ id: `d-${i}`, text }));
}

describe('parseDoneWhenInput', () => {
  it('separates "no lines named" from "an empty list"', () => {
    expect(parseDoneWhenInput(undefined)).toEqual({ ok: true });
    expect(parseDoneWhenInput([])).toEqual({ ok: true, lines: [] });
  });

  it('accepts a bare string as a line, and trims it', () => {
    const parsed = parseDoneWhenInput(['  the share link opens  ', { text: 'and it lists' }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines?.map((l) => l.text)).toEqual(['the share link opens', 'and it lists']);
  });

  it('refuses a line with no words, a line that is too long, and a payload that is not a list', () => {
    expect(parseDoneWhenInput([{ text: '   ' }]).ok).toBe(false);
    expect(parseDoneWhenInput([{ text: 'x'.repeat(501) }]).ok).toBe(false);
    expect(parseDoneWhenInput({ text: 'not a list' }).ok).toBe(false);
  });

  it('refuses more lines than a task may carry', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ text: `line ${i}` }));
    const parsed = parseDoneWhenInput(many);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('too-many-lines');
  });
});

describe('buildDoneWhenLines', () => {
  it("keeps a named line's verdict and proof while replacing its words", () => {
    const previous: DoneWhenLine[] = [
      { id: 'd-0', text: 'old words', verdict: 'met', proof: [{ text: 'ran it' }] },
    ];
    const [kept] = buildDoneWhenLines([{ id: 'd-0', text: 'new words' }], previous);
    expect(kept?.text).toBe('new words');
    expect(kept?.verdict).toBe('met');
    expect(kept?.proof?.[0]?.text).toBe('ran it');
  });

  it('mints a fresh line for an input with no id, and drops a previous line nobody named', () => {
    const previous: DoneWhenLine[] = [{ id: 'd-0', text: 'dropped', verdict: 'met' }];
    const built = buildDoneWhenLines([{ text: 'brand new' }], previous);
    expect(built).toHaveLength(1);
    expect(built[0]?.id).not.toBe('d-0');
    expect(built[0]?.verdict).toBeUndefined();
  });
});

describe('TaskDoneWhenStore.report', () => {
  it('writes a verdict with its proof and saves the board', () => {
    const task = makeTask(lines('the list renders'));
    const { store, saved } = fake(task);

    const res = store.report(
      task.id,
      [{ id: 'd-0', verdict: 'met', proof: [{ text: 'read it', url: 'https://example.test/x' }] }],
      AGENT,
    );

    expect(res.ok).toBe(true);
    expect(task.doneWhen?.[0]?.verdict).toBe('met');
    expect(task.doneWhen?.[0]?.proof?.[0]?.url).toBe('https://example.test/x');
    expect(task.doneWhen?.[0]?.by).toBe('Harborlight');
    expect(saved).toEqual(['ws-1']);
  });

  it('refuses met with no proof, names the line, and writes NOTHING from that report', () => {
    const task = makeTask(lines('the first outcome', 'the second outcome'));
    const { store, saved } = fake(task);

    const res = store.report(
      task.id,
      [
        { id: 'd-0', verdict: 'met', proof: [{ text: 'proved it' }] },
        { id: 'd-1', verdict: 'met' },
      ],
      AGENT,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('proof-required');
    expect(res.message).toContain('the second outcome');
    // The valid half of the report is not applied either — the whole report
    // is validated before any of it is written.
    expect(task.doneWhen?.[0]?.verdict).toBeUndefined();
    expect(saved).toEqual([]);
  });

  it('keeps a line met when a later report re-asserts it with no new proof', () => {
    const task = makeTask([
      { id: 'd-0', text: 'proved once', verdict: 'met', proof: [{ text: 'ran it' }] },
    ]);
    const { store } = fake(task);

    const res = store.report(task.id, [{ id: 'd-0', verdict: 'met' }], AGENT);

    expect(res.ok).toBe(true);
    expect(task.doneWhen?.[0]?.proof?.[0]?.text).toBe('ran it');
  });

  it('refuses a line the task does not carry, and a report on a task with no list', () => {
    const withLines = makeTask(lines('an outcome'));
    const unknown = fake(withLines).store.report(
      withLines.id,
      [{ id: 'd-nope', verdict: 'not-met' }],
      AGENT,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe('unknown-line');

    const bare = makeTask();
    const none = fake(bare).store.report(bare.id, [{ id: 'd-0', verdict: 'met' }], AGENT);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toBe('no-lines');
  });

  it('closes the task once the last line is met, and pins one note naming that line', () => {
    const task = makeTask(lines('the first outcome', 'the closing outcome'));
    const { store, moves, notes } = fake(task);

    store.report(task.id, [{ id: 'd-0', verdict: 'met', proof: [{ text: 'a' }] }], AGENT);
    expect(moves).toHaveLength(0);

    const res = store.report(
      task.id,
      [{ id: 'd-1', verdict: 'met', proof: [{ text: 'b' }] }],
      AGENT,
    );

    expect(res.ok && res.closed).toBe(true);
    expect(moves).toEqual([{ taskId: 't-1', to: 'done' }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('the closing outcome');
  });

  it('leaves the task open when the transition gate refuses the close', () => {
    const task = makeTask(lines('the only outcome'));
    const { store, notes } = fake(task, { transitionOk: false });

    const res = store.report(
      task.id,
      [{ id: 'd-0', verdict: 'met', proof: [{ text: 'a' }] }],
      AGENT,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Every line met and the task still open is the honest state — and no
    // note claims a close that did not happen.
    expect(res.closed).toBe(false);
    expect(task.status).toBe('in-progress');
    expect(notes).toEqual([]);
  });

  it('does not close on a verdict that is not met', () => {
    for (const verdict of ['not-met', 'unchecked', 'owner'] as const) {
      const task = makeTask(lines('the only outcome'));
      const { store, moves } = fake(task);
      const res = store.report(task.id, [{ id: 'd-0', verdict }], AGENT);
      expect(res.ok && res.closed).toBe(false);
      expect(moves).toEqual([]);
    }
  });
});

describe('TaskDoneWhenStore.ownerCheck', () => {
  it("takes a person's word with no proof and closes the task", () => {
    const task = makeTask([{ id: 'd-0', text: 'it reads well', verdict: 'owner' }]);
    const { store, moves } = fake(task);

    const res = store.ownerCheck(task.id, 'd-0', 'met', PERSON);

    expect(res.ok && res.closed).toBe(true);
    expect(task.doneWhen?.[0]?.verdict).toBe('met');
    expect(task.doneWhen?.[0]?.by).toBe('Bryan');
    expect(moves).toEqual([{ taskId: 't-1', to: 'done' }]);
  });

  it('refuses an agent, and writes nothing', () => {
    const task = makeTask([{ id: 'd-0', text: 'it reads well', verdict: 'owner' }]);
    const { store, saved } = fake(task);

    const res = store.ownerCheck(task.id, 'd-0', 'met', AGENT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-a-person');
    expect(task.doneWhen?.[0]?.verdict).toBe('owner');
    expect(saved).toEqual([]);
  });

  it("sends a line back with the owner's Not met, and does not close", () => {
    const task = makeTask([{ id: 'd-0', text: 'it reads well', verdict: 'owner' }]);
    const { store, moves } = fake(task);

    const res = store.ownerCheck(task.id, 'd-0', 'not-met', PERSON);

    expect(res.ok && res.closed).toBe(false);
    expect(task.doneWhen?.[0]?.verdict).toBe('not-met');
    expect(moves).toEqual([]);
  });
});

describe('TaskDoneWhenStore.setLines', () => {
  it('clears the list with an empty write, and drops the field rather than storing []', () => {
    const task = makeTask(lines('an outcome nobody wants'));
    const { store } = fake(task);

    const res = store.setLines(task.id, [], AGENT);

    expect(res.ok).toBe(true);
    expect(task.doneWhen).toBeUndefined();
  });

  it('closes the task when the edit removes the last OPEN line', () => {
    const task = makeTask([
      { id: 'd-0', text: 'proved', verdict: 'met', proof: [{ text: 'ran it' }] },
      { id: 'd-1', text: 'no longer what done means' },
    ]);
    const { store, moves } = fake(task);

    const res = store.setLines(task.id, [{ id: 'd-0', text: 'proved' }], AGENT);

    expect(res.ok && res.closed).toBe(true);
    expect(moves).toEqual([{ taskId: 't-1', to: 'done' }]);
  });

  it('refuses a task that does not exist', () => {
    const task = makeTask();
    const { store } = fake(task);
    const res = store.setLines('t-ghost', [{ text: 'anything' }], AGENT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });
});
