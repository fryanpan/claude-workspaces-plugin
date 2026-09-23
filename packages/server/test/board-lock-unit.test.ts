/**
 * The never-shareable lock's pure half: the request parser, the log line,
 * the retired `share_doc` lookup, and `SharingGate`'s `lockedBoards`. The
 * routes are `board-lock.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import {
  boardLockLine,
  boardLockedRefusal,
  lockedBoardNamedBy,
  parseLockRequest,
} from '../src/share/board-lock.ts';
import { SharingGate } from '../src/share/sharing-gate.ts';

describe('parseLockRequest', () => {
  it('reads a full request', () => {
    expect(
      parseLockRequest({
        workspaceId: ' b-harborlight ',
        locked: true,
        reason: ' private files ',
        actor: { id: 'a-1', name: 'Alice' },
      }),
    ).toEqual({
      ok: true,
      value: {
        workspaceId: 'b-harborlight',
        locked: true,
        reason: 'private files',
        actor: { id: 'a-1', name: 'Alice' },
      },
    });
  });

  it('refuses a field it would otherwise drop, and names it', () => {
    const r = parseLockRequest({ workspaceId: 'b-1', locked: true, enabled: false });
    expect(r).toEqual({ ok: false, error: 'unknown field(s): enabled' });
  });

  it('refuses a missing board, a non-boolean lock and a bad actor', () => {
    expect(parseLockRequest(null).ok).toBe(false);
    expect(parseLockRequest({ locked: true }).ok).toBe(false);
    expect(parseLockRequest({ workspaceId: 'b-1', locked: 'yes' }).ok).toBe(false);
    expect(parseLockRequest({ workspaceId: 'b-1', locked: true, actor: 'Bob' }).ok).toBe(false);
    expect(parseLockRequest({ workspaceId: 'b-1', locked: true, reason: 7 }).ok).toBe(false);
  });
});

describe('boardLockLine', () => {
  it('is one stamped line saying who, from where and why', () => {
    const line = boardLockLine({
      workspaceId: 'b-1',
      locked: true,
      actor: 'Alice',
      peer: '127.0.0.1',
      reason: 'line one\nline two',
      at: Date.UTC(2026, 8, 23, 12, 0, 0),
    });
    expect(line).toMatch(STAMP_PATTERN);
    expect(line).toContain('locked never-shareable');
    expect(line).toContain('from 127.0.0.1');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('boardLockedRefusal', () => {
  it('names the lock and the board', () => {
    const r = boardLockedRefusal('b-1');
    expect(r.error).toBe('board_never_shareable');
    expect(r.workspaceId).toBe('b-1');
    expect(r.hint).toContain('locked never-shareable');
  });
});

describe('lockedBoardNamedBy', () => {
  const deps = {
    isBoardLocked: (id: string) => id === 'b-locked',
    boardsHolding: (docId: string) => (docId === 'd-1' ? ['b-open', 'b-locked'] : ['b-open']),
  };
  it('finds a locked board named directly or through a doc', () => {
    expect(lockedBoardNamedBy({ workspaceId: 'b-locked' }, deps)).toBe('b-locked');
    expect(lockedBoardNamedBy({ docId: 'd-1' }, deps)).toBe('b-locked');
  });
  it('CONTROL: finds nothing on open boards or an empty body', () => {
    expect(lockedBoardNamedBy({ workspaceId: 'b-open' }, deps)).toBeNull();
    expect(lockedBoardNamedBy({ docId: 'd-2' }, deps)).toBeNull();
    expect(lockedBoardNamedBy(null, deps)).toBeNull();
  });
});

describe('SharingGate lockedBoards', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-lock-gate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists a lock, which closes the board to visitors as well', () => {
    const gate = new SharingGate({ dataDir: dir });
    expect(gate.setBoardLocked('b-1', true)).toEqual({
      ok: true,
      workspaceId: 'b-1',
      locked: true,
    });
    const again = new SharingGate({ dataDir: dir });
    expect(again.isBoardLocked('b-1')).toBe(true);
    expect(again.isBoardOpen('b-1')).toBe(false);
    expect(again.isBoardOpen('b-2')).toBe(true);
    expect(again.status().lockedBoards).toEqual(['b-1']);
  });

  it('is not undone by reopening the board', () => {
    const gate = new SharingGate({ dataDir: dir });
    gate.setBoardLocked('b-1', true);
    gate.setBoardEnabled('b-1', true);
    expect(gate.isBoardOpen('b-1')).toBe(false);
    gate.setBoardLocked('b-1', false);
    expect(gate.isBoardOpen('b-1')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'sharing.json'), 'utf8'))).toEqual({ enabled: true });
  });

  it('is refused under the env lock', () => {
    const gate = new SharingGate({ dataDir: dir, envLocked: true });
    expect(gate.setBoardLocked('b-1', true)).toEqual({ ok: false, error: 'env_locked' });
  });

  it('fails closed on a lockedBoards list of the wrong shape', () => {
    writeFileSync(join(dir, 'sharing.json'), '{"enabled": true, "lockedBoards": "b-1"}');
    const gate = new SharingGate({ dataDir: dir });
    expect(gate.isEnabled()).toBe(false);
    expect(gate.loadError).toContain('lockedBoards');
  });
});
