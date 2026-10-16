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
import type { BoardPrivacy } from '../src/coach/exclusion.ts';
import {
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

function wire(privacy: Partial<BoardPrivacy> = {}, overrides: Partial<CoachWiringDeps> = {}) {
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
    privacy: {
      localOnlyBoard: () => false,
      localOnlyDoc: () => false,
      locked: () => false,
      boardsOfDoc: () => [],
      ...privacy,
    },
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

  it('never opens a window on a turn end, and stops counting at an injected prompt', () => {
    const { w, sent, closeWindows } = wire();
    for (const minute of [0, 20, 40]) {
      expect(w.sessionTurn('w-harbor', turnNote(HARBOR_LEAD, minute), HARBOR_CWD)).toBe(false);
    }
    closeWindows();
    expect(sent).toEqual([]);
    w.sessionPrompt('w-harbor', typed('Bob', 50), HARBOR_CWD);
    w.sessionPrompt('w-harbor', typed('Bob', 51, 'sess-1', false), HARBOR_CWD);
    expect(w.sessionTurn('w-harbor', turnNote('Bob', 52), HARBOR_CWD)).toBe(false);
    closeWindows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessions: [{ repo: 'harborlight-app', prompts: 1, turns: 0 }],
    });
    w.stop();
  });

  it('leaves out a session on a board the coach is off for, entirely, and the coach’s own', () => {
    const { w, sent, closeWindows } = wire({ locked: (ws) => ws === 'w-river' });
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
  it('counts turn ends from a typed prompt on, each gap capped, until an injected prompt', () => {
    const runs = new SessionRuns();
    expect(runs.turnEnd('a', 0)).toBeNull();
    runs.prompt('a', 0, true);
    expect(runs.turnEnd('a', 2 * MIN)).toBe(2 * MIN);
    expect(runs.turnEnd('a', 60 * MIN)).toBe(TURN_CAP_MS);
    expect(runs.turnEnd('a', 59 * MIN)).toBe(0);
    expect(runs.turnEnd('b', 61 * MIN)).toBeNull();
    runs.prompt('a', 62 * MIN, false);
    expect(runs.turnEnd('a', 63 * MIN)).toBeNull();
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
