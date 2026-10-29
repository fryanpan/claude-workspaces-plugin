/**
 * The coach's digest lists the owner's Claude Code time: per attached
 * session, the repo and its active minutes, and never what the turn said.
 * Time counts only from a prompt he typed through the turn ends after it; a
 * turn end never opens a window, so agents working alone wake nobody. The
 * coach's own session never counts, a board the coach is off for is left
 * out entirely, and every digest says once what is not counted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core';
import type { DocBoards } from '../src/coach/exclusion.ts';
import {
  READ_CAP_MS,
  RUN_IDLE_MS,
  SESSIONS_NOT_COUNTED,
  SessionRuns,
  TURN_CAP_MS,
  repoOfCwd,
} from '../src/coach/session-minutes.ts';
import { type CoachWiringDeps, wireCoach } from '../src/coach/wiring.ts';
import { GOALS_DOC, at } from './coach-fixtures.ts';

const MIN = 60_000;
const HARBOR_LEAD = 'Harborlight lead';
const RIVER_LEAD = 'Riverbend lead';
const COACH = 'Saltmarsh coach';
const LEADS: Record<string, string> = {
  'w-coach': agentIdForName(COACH),
  'w-harbor': agentIdForName(HARBOR_LEAD),
  'w-river': agentIdForName(RIVER_LEAD),
};
const NAMES: Record<string, string> = { 'w-harbor': 'Harborlight', 'w-river': 'Riverbend' };
const SECRET_TEXT = 'Berths 4 and 5 are free after the tide turns.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-minutes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wire(docBoards: Partial<DocBoards> = {}, overrides: Partial<CoachWiringDeps> = {}) {
  const windows: (() => void)[] = [];
  const sent: unknown[] = [];
  const deps: CoachWiringDeps = {
    dataDir: dir,
    docStore: {
      prewarmHydration: async () => undefined,
      createForCaller: (docId) => ({ ok: true, doc: { docId } }),
      attachFileAsync: async () => ({ ok: true }),
      docExists: () => true,
      readMarkdownBody: () => GOALS_DOC,
    },
    createBoard: () => 'w-coach',
    fileUnderBoard: () => {},
    label: () => ({}),
    boardName: (ws) => NAMES[ws],
    workspaceOf: () => 'w-coach',
    docBoards: { boardsOfDoc: () => [], ...docBoards },
    leadOf: (ws) => LEADS[ws],
    sendToAgent: (_ws, _agent, frame) => {
      sent.push(frame);
      return 1;
    },
    agentConnected: () => true,
    planBoard: () => undefined,
    now: () => at(9),
    schedule: (fn) => {
      windows.push(fn);
      return () => {};
    },
    ...overrides,
  };
  const w = wireCoach(deps);
  w.store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: at(9) });
  const closeWindows = () => {
    for (const close of windows.splice(0)) close();
  };
  return { w, sent, closeWindows };
}

const turnNote = (agent: string, minute: number, sessionId = 'sess-1') => ({
  agent,
  kind: 'turn' as const,
  text: SECRET_TEXT,
  at: at(9, minute),
  sessionId,
});
const typed = (agent: string, minute: number, sessionId = 'sess-1', isTyped = true) => ({
  agent,
  typed: isTyped,
  at: at(9, minute),
  sessionId,
});
const HARBOR_CWD = '/work/dev/harborlight-app/.claude/worktrees/tide-tables';

const SALT_CWD = '/work/dev/saltmarsh';

describe('the digest’s Claude Code section', () => {
  it('lists repo and active minutes per attached session, from his typed prompts, without the turn text, and says once what is not counted', () => {
    const { w, sent, closeWindows } = wire();
    expect(w.sessionPrompt('w-harbor', typed('Bob', 0), HARBOR_CWD)).toBe(true);
    for (const minute of [3, 5, 12]) {
      expect(w.sessionTurn('w-harbor', turnNote('Bob', minute), HARBOR_CWD)).toBe(true);
    }
    w.sessionPrompt('w-harbor', typed('Alice', 4, 'sess-2'), SALT_CWD);
    closeWindows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'coach.digest',
      items: [],
      sessions: [
        {
          boardId: 'w-harbor',
          board: 'Harborlight',
          repo: 'harborlight-app',
          minutes: 10,
          prompts: 1,
          turns: 3,
        },
        { boardId: 'w-harbor', repo: 'saltmarsh', minutes: 1, prompts: 1, turns: 0 },
      ],
      sessionsNote: SESSIONS_NOT_COUNTED,
    });
    const frame = JSON.stringify(sent[0]);
    expect(frame).not.toContain('Berths');
    expect(frame).not.toContain('sess-1');
    expect(frame).not.toContain('/work');
    expect(frame).not.toContain('tide-tables');
    expect(frame.split(SESSIONS_NOT_COUNTED)).toHaveLength(2);
    w.stop();
  });

  it('never opens a window on a turn end outside a run, and keeps counting past an injected prompt', () => {
    const { w, sent, closeWindows } = wire();
    for (const minute of [0, 20, 40]) {
      expect(w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, minute), HARBOR_CWD)).toBe(false);
    }
    closeWindows();
    expect(sent).toEqual([]);
    w.sessionPrompt('w-harbor', typed('Bob', 50), HARBOR_CWD);
    w.sessionPrompt('w-harbor', typed('Bob', 51, 'sess-1', false), HARBOR_CWD);
    expect(w.sessionTurn('w-harbor', turnNote('Bob', 52), HARBOR_CWD)).toBe(true);
    closeWindows();
    expect(sent).toHaveLength(1);
    // 10 minutes reading since the turn end at :40, then 1 and 1.
    expect(sent[0]).toMatchObject({
      sessions: [{ repo: 'harborlight-app', prompts: 1, turns: 1, minutes: 12 }],
    });
    w.stop();
  });

  it('opens a window on a turn end in his run, after the window his prompt opened has gone', () => {
    const { w, sent, closeWindows } = wire();
    w.sessionPrompt('w-harbor', typed('Bob', 0), HARBOR_CWD);
    closeWindows();
    expect(sent).toHaveLength(1);
    expect(w.sessionTurn('w-harbor', turnNote('Bob', 4), HARBOR_CWD)).toBe(true);
    closeWindows();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ sessions: [{ prompts: 0, turns: 1, minutes: 4 }] });
    w.stop();
  });

  it('leaves out a session on a board the coach is off for, entirely, and the coach’s own', () => {
    const { w, sent, closeWindows } = wire();
    w.store.setBoardOff('w-river', true);
    expect(w.sessionPrompt('w-river', typed(RIVER_LEAD, 0), '/work/riverbend')).toBe(false);
    closeWindows();
    expect(sent).toEqual([]);
    w.sessionPrompt('w-harbor', typed('Bob', 1), HARBOR_CWD);
    w.sessionPrompt('w-river', typed(RIVER_LEAD, 1), '/work/riverbend');
    w.sessionTurn('w-river', turnNote(RIVER_LEAD, 2), '/work/riverbend');
    expect(w.sessionPrompt('w-coach', typed(COACH, 2), '/work/coach')).toBe(false);
    closeWindows();
    expect(JSON.stringify(sent)).not.toContain('iverbend');
    expect(JSON.stringify(sent)).not.toContain('w-river');
    expect(JSON.stringify(sent)).not.toContain('"repo":"coach"');
    w.store.setBoardOff('w-harbor', true);
    expect(w.sessionPrompt('w-harbor', typed('Bob', 3), HARBOR_CWD)).toBe(false);
    w.stop();
  });
});

/** A seeded random number in [0, 1), so the replayed day is the same every run. */
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A replayed day of steady work in one session: three stretches at the
 * keyboard, split by lunch and a break. Each typed prompt sets the agent
 * working for 1 to 9 minutes; a third of its turn ends draw a channel event
 * the harness injects, and a short turn after it; then he reads for 1 to 7
 * minutes and types again. The time he spent is each stretch from when he
 * sat down (reading before his first prompt) to the end of his last read.
 */
function replayDay(seed: number) {
  const rand = seeded(seed);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const marks: { at: number; kind: 'typed' | 'injected' | 'turn' }[] = [];
  let spentMs = 0;
  const stretches: [number, number][] = [
    [at(9), at(12)],
    [at(12, 45), at(15)],
    [at(15, 20), at(17, 30)],
  ];
  for (const [i, [start, end]] of stretches.entries()) {
    let t = start;
    const satDown = i === 0 ? t : t - between(1, 7) * MIN;
    let lastRead = t;
    while (t < end) {
      marks.push({ at: t, kind: 'typed' });
      t += between(1, 9) * MIN;
      marks.push({ at: t, kind: 'turn' });
      if (rand() < 1 / 3) {
        t += 0.5 * MIN;
        marks.push({ at: t, kind: 'injected' });
        t += between(1, 3) * MIN;
        marks.push({ at: t, kind: 'turn' });
      }
      t += between(1, 7) * MIN;
      lastRead = t;
    }
    spentMs += lastRead - satDown;
  }
  return { marks, spentMinutes: spentMs / MIN };
}

describe('a replayed day of steady work', () => {
  it('counts active minutes within 20% of the time he spent, reading included', () => {
    for (const seed of [1, 2, 3]) {
      let clock = at(8);
      const timers: { due: number; fn: () => void }[] = [];
      const runDue = () => {
        for (;;) {
          timers.sort((a, b) => a.due - b.due);
          const next = timers[0];
          if (!next || next.due > clock) return;
          timers.shift();
          next.fn();
        }
      };
      const { w, sent } = wire(
        {},
        {
          now: () => clock,
          schedule: (fn, ms) => {
            timers.push({ due: clock + ms, fn });
            return () => {};
          },
        },
      );
      const { marks, spentMinutes } = replayDay(seed);
      for (const m of marks) {
        clock = m.at;
        runDue();
        if (m.kind === 'turn') {
          w.sessionTurn('w-harbor', { ...turnNote('Bob', 0, 'sess-day'), at: m.at }, HARBOR_CWD);
        } else {
          const mark = { ...typed('Bob', 0, 'sess-day', m.kind === 'typed'), at: m.at };
          w.sessionPrompt('w-harbor', mark, HARBOR_CWD);
        }
      }
      clock = at(23);
      runDue();
      const counted = (sent as { sessions?: { minutes: number }[] }[])
        .flatMap((d) => d.sessions ?? [])
        .reduce((sum, line) => sum + line.minutes, 0);
      expect(Math.abs(counted - spentMinutes) / spentMinutes).toBeLessThanOrEqual(0.2);
      w.stop();
    }
  });
});

describe('the coach lead’s stream', () => {
  it('logs one timestamped line per connect and disconnect, and nothing for other agents or boards', () => {
    let connected = false;
    let clock = at(9);
    const lines: string[] = [];
    const { w } = wire(
      {},
      {
        agentConnected: (_ws, agent) => agent === LEADS['w-coach'] && connected,
        now: () => clock,
        log: (line) => lines.push(line),
      },
    );
    connected = true;
    w.agentStreamsChanged('w-coach', LEADS['w-coach']);
    w.agentStreamsChanged('w-coach', LEADS['w-coach']);
    w.agentStreamsChanged('w-coach', agentIdForName(HARBOR_LEAD));
    w.agentStreamsChanged('w-harbor', LEADS['w-harbor']);
    clock = at(10, 5);
    connected = false;
    w.agentStreamsChanged('w-coach', LEADS['w-coach']);
    expect(lines).toEqual([
      `[coach] session stream connected at ${new Date(at(9)).toISOString()}`,
      `[coach] session stream disconnected at ${new Date(at(10, 5)).toISOString()}`,
    ]);
    w.stop();
  });
});

describe('SessionRuns', () => {
  it('credits the gap since the previous mark, capped by kind, while a typed prompt is recent', () => {
    const runs = new SessionRuns();
    expect(runs.mark('a', 0, 'turn')).toBeNull();
    // Reading since the agent's turn end at 0.
    expect(runs.mark('a', 3 * MIN, 'typed')).toBe(3 * MIN);
    expect(runs.mark('a', 5 * MIN, 'turn')).toBe(2 * MIN);
    expect(runs.mark('a', 20 * MIN, 'turn')).toBe(TURN_CAP_MS);
    expect(runs.mark('a', 19 * MIN, 'turn')).toBe(0);
    // An injected prompt counts and does not end the run.
    expect(runs.mark('a', 21 * MIN, 'injected')).toBe(MIN);
    expect(runs.mark('a', 22 * MIN, 'turn')).toBe(MIN);
    expect(runs.mark('b', 61 * MIN, 'turn')).toBeNull();
    // Past RUN_IDLE_MS since his prompt at 3, nothing counts.
    expect(runs.mark('a', 3 * MIN + RUN_IDLE_MS + 1, 'turn')).toBeNull();
    // The next morning's prompt adds no more than READ_CAP_MS.
    expect(runs.mark('a', 600 * MIN, 'typed')).toBe(READ_CAP_MS);
    expect(runs.mark('c', 0, 'typed')).toBe(0);
  });
});

describe('repoOfCwd', () => {
  it('names the repo folder, a worktree by its repo, and nothing for a non-path', () => {
    expect(repoOfCwd('/work/dev/harborlight-app')).toBe('harborlight-app');
    expect(repoOfCwd('/work/dev/harborlight-app/')).toBe('harborlight-app');
    expect(repoOfCwd(HARBOR_CWD)).toBe('harborlight-app');
    expect(repoOfCwd('relative/riverbend')).toBeUndefined();
    expect(repoOfCwd(42)).toBeUndefined();
    expect(repoOfCwd('/')).toBeUndefined();
  });
});
