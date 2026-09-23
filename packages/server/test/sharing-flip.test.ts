/**
 * The switch request parser and the log line, on their own. The route-level
 * behaviour is `sharing-switch.test.ts`; this file pins the two properties
 * that suite relies on: nothing the caller sent is silently dropped, and no
 * caller-supplied text can start a second log line.
 */
import { describe, expect, it } from 'bun:test';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import {
  FLIP_REASON_MAX,
  flipActor,
  parseFlipRequest,
  sharingFlipLine,
} from '../src/share/sharing-flip.ts';

describe('parseFlipRequest', () => {
  it('reads the master switch, a board, a reason and an actor', () => {
    expect(parseFlipRequest({ enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(
      parseFlipRequest({
        enabled: false,
        workspaceId: ' w-harbor ',
        reason: ' precaution ',
        actor: { id: 'agent-bob', name: 'Bob' },
      }),
    ).toEqual({
      ok: true,
      value: {
        enabled: false,
        workspaceId: 'w-harbor',
        reason: 'precaution',
        actor: { id: 'agent-bob', name: 'Bob' },
      },
    });
  });

  it('refuses a key it does not read, naming it', () => {
    const r = parseFlipRequest({ enabled: false, board: 'w-harbor', scope: 'one' });
    expect(r).toEqual({ ok: false, error: 'unknown field(s): board, scope' });
  });

  it('refuses hostile shapes', () => {
    for (const body of [
      null,
      {},
      { enabled: 'no' },
      { enabled: false, workspaceId: '' },
      { enabled: false, workspaceId: 7 },
      { enabled: false, reason: 3 },
      { enabled: false, reason: 'x'.repeat(FLIP_REASON_MAX + 1) },
      { enabled: false, actor: 'bob' },
      { enabled: false, actor: { name: 'x'.repeat(201) } },
    ]) {
      expect(
        parseFlipRequest(body as Record<string, unknown> | null).ok,
        JSON.stringify(body),
      ).toBe(false);
    }
  });
});

describe('flipActor', () => {
  it('prefers the claimed agent, then the proven person, then says unattributed', () => {
    expect(flipActor({ id: 'agent-bob', name: 'Bob' }, { email: 'alice@riverbend.example' })).toBe(
      'agent Bob (agent-bob)',
    );
    expect(flipActor(undefined, { email: 'alice@riverbend.example' })).toBe(
      'person alice@riverbend.example',
    );
    expect(flipActor(undefined, null)).toBe('unattributed');
  });
});

describe('sharingFlipLine', () => {
  const at = Date.UTC(2026, 8, 23, 0, 9, 0);

  it('is one stamped line naming what, who, where and why', () => {
    const line = sharingFlipLine({
      enabled: false,
      actor: 'agent Bob',
      peer: '127.0.0.1',
      reason: 'review',
      at,
    });
    expect(line).toMatch(STAMP_PATTERN);
    expect(line).toBe(
      '2026-09-23T00:09:00.000Z [sharing] master switch OFF by "agent Bob" from 127.0.0.1 reason="review"',
    );
  });

  it('keeps a reason or a name with a newline on one line', () => {
    const line = sharingFlipLine({
      workspaceId: 'w-harbor',
      enabled: true,
      actor: 'agent\nforged',
      peer: '127.0.0.1',
      reason: 'a\n2026-01-01T00:00:00.000Z [sharing] master switch ON',
      at,
    });
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('board "w-harbor" opened to outside visitors');
  });
});
