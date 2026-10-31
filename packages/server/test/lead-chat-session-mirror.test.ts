/**
 * `LeadSessionMirror` on its own: which flushes of a streaming message it
 * shows, and the one-line summary of a tool call.
 */
import { describe, expect, it } from 'bun:test';
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { LeadSessionMirror, toolSummary } from '../src/lead-chat/mirror.ts';

function setup(lead = 'Harborlight Lead') {
  const shown: Array<{ m: LeadChatMessage; store: boolean }> = [];
  let n = 0;
  const mirror = new LeadSessionMirror(
    {
      isLead: (_ws, name) => name === lead,
      leadAuthor: (_ws, name) => ({ id: 'harborlight-lead', name }),
      showMirrored: (_ws, m, store) => {
        shown.push({ m, store });
        return true;
      },
    },
    () => `id-${++n}`,
    () => 1000 + n,
  );
  return { mirror, shown };
}

const flush = (index: number, final: boolean, text: string) => ({
  messageId: 'msg-1',
  index,
  final,
  text,
});

describe('LeadSessionMirror', () => {
  it('shows each newer flush under one id and stores only the final one', () => {
    const { mirror, shown } = setup();
    mirror.text('w', 'Harborlight Lead', flush(0, false, 'one'));
    mirror.text('w', 'Harborlight Lead', flush(1, true, 'one\ntwo'));
    expect(shown.map((s) => [s.m.id, s.m.text, s.m.streaming ?? false, s.store])).toEqual([
      ['id-1', 'one', true, false],
      ['id-1', 'one\ntwo', false, true],
    ]);
  });

  it('drops a flush older than the one shown, and any flush after the final', () => {
    const { mirror, shown } = setup();
    mirror.text('w', 'Harborlight Lead', flush(3, false, 'newer'));
    mirror.text('w', 'Harborlight Lead', flush(2, false, 'older'));
    mirror.text('w', 'Harborlight Lead', flush(4, true, 'whole'));
    mirror.text('w', 'Harborlight Lead', flush(5, false, 'after'));
    expect(shown.map((s) => s.m.text)).toEqual(['newer', 'whole']);
  });

  it('keeps the same message id apart on two boards', () => {
    const { mirror, shown } = setup();
    mirror.text('w1', 'Harborlight Lead', flush(0, true, 'a'));
    mirror.text('w2', 'Harborlight Lead', flush(0, true, 'b'));
    expect(new Set(shown.map((s) => s.m.id)).size).toBe(2);
  });

  it('shows nothing for a session that is not the lead', () => {
    const { mirror, shown } = setup();
    expect(mirror.text('w', 'Riverbend Helper', flush(0, true, 'x'))).toBe(false);
    expect(mirror.tools('w', 'Riverbend Helper', [{ name: 'Bash', input: 'ls' }])).toBe(false);
    expect(shown).toEqual([]);
  });

  it('stores one row per tool call, each with its own id', () => {
    const { mirror, shown } = setup();
    mirror.tools('w', 'Harborlight Lead', [
      { name: 'Bash', input: 'ls' },
      { name: 'Read', input: 'a.md', output: 'text' },
    ]);
    expect(shown.map((s) => [s.m.text, s.store, s.m.via])).toEqual([
      ['Bash: ls', true, 'terminal'],
      ['Read: a.md', true, 'terminal'],
    ]);
    expect(shown[0]?.m.id).not.toBe(shown[1]?.m.id);
  });
});

describe('toolSummary', () => {
  it('names the tool and the first line of its input, capped', () => {
    expect(toolSummary({ name: 'Bash', input: '\n  git log\n--oneline' })).toBe('Bash: git log');
    expect(toolSummary({ name: 'TodoWrite', input: '' })).toBe('TodoWrite');
    const long = toolSummary({ name: 'Bash', input: 'x'.repeat(400) });
    expect(long.length).toBe(160);
    expect(long.endsWith('…')).toBe(true);
  });
});
