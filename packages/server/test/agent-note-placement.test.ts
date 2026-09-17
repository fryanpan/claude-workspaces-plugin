/**
 * The four states an agent's turn notes can be in, named for the reader —
 * unit cases for `agent-note-placement.ts`. The route cases that drive the
 * same module through a server are `turn-note-surface.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { LoggedAgentNote } from '../src/agent-note-log.ts';
import {
  agentNotesByAgent,
  parseWithheld,
  placementOfLogged,
  placementOfTarget,
} from '../src/agent-note-placement.ts';
import { AT_PAST_MS } from '../src/agent-notes.ts';
import type { Task } from '../src/tasks.ts';

const line = (over: Partial<LoggedAgentNote>): LoggedAgentNote => ({
  agent: 'Harborlight',
  kind: 'turn',
  text: 'Rebased and pushed.',
  at: 1_000,
  workspaceId: 'w-1',
  ambiguous: false,
  ...over,
});

describe('placementOfLogged', () => {
  it('names the three states a log line can record, never the word "ambiguous"', () => {
    expect(placementOfLogged({ ambiguous: true })).toBe('undecidable');
    expect(placementOfLogged({ ambiguous: false })).toBe('unattachable');
    // A declaration wins over the flag it happens to carry.
    expect(placementOfLogged({ ambiguous: true, withheld: true })).toBe('withheld');
  });
});

describe('placementOfTarget', () => {
  it('is attached only when the resolver named a task', () => {
    const task = { id: 't-1' } as Task;
    expect(placementOfTarget({ task, ambiguous: false })).toBe('attached');
    expect(placementOfTarget({ task: undefined, ambiguous: true })).toBe('undecidable');
    expect(placementOfTarget({ task: undefined, ambiguous: false })).toBe('unattachable');
  });
});

describe('agentNotesByAgent', () => {
  it('groups by agent under the roster fold, newest agent first, newest line first', () => {
    const views = agentNotesByAgent([
      line({ agent: 'Harborlight', at: 100, text: 'older', ambiguous: true }),
      line({ agent: 'Riverbend', at: 300, text: 'river' }),
      line({ agent: 'harborlight', at: 200, text: 'newer', ambiguous: true }),
    ]);
    expect(views.map((v) => [v.agent, v.placement, v.latestAt])).toEqual([
      ['Riverbend', 'unattachable', 300],
      ['harborlight', 'undecidable', 200],
    ]);
    expect(views[1]?.notes.map((n) => n.text)).toEqual(['newer', 'older']);
  });

  it('takes the header from the NEWEST line, so a later turn changes the state', () => {
    const [view] = agentNotesByAgent([
      line({ at: 100, ambiguous: true }),
      line({ at: 200, ambiguous: false, text: 'now holds nothing' }),
    ]);
    expect(view?.placement).toBe('unattachable');
    // Each line keeps the state it was written in.
    expect(view?.notes.map((n) => n.placement)).toEqual(['unattachable', 'undecidable']);
  });

  it('shows a declaration as a state with no words, and never as a note', () => {
    const [view] = agentNotesByAgent([
      line({ agent: 'Saltmarsh', at: 500, text: '', withheld: true }),
      line({ agent: 'Saltmarsh', at: 400, text: '', withheld: true }),
    ]);
    expect(view).toMatchObject({ agent: 'Saltmarsh', placement: 'withheld', latestAt: 500 });
    expect(view?.notes).toEqual([]);
    expect(view?.more).toBe(0);
  });

  it('lets a newer placed note win the header while the old unplaced notes stay listed', () => {
    const lines = [line({ at: 100, ambiguous: true, text: 'before the second task closed' })];
    const later = agentNotesByAgent(lines, () => ({ at: 150, taskId: 't-9' }));
    expect(later[0]).toMatchObject({ placement: 'attached', taskId: 't-9', latestAt: 150 });
    expect(later[0]?.notes.map((n) => n.text)).toEqual(['before the second task closed']);
    // An OLDER placed note does not: the latest turn was the unplaced one.
    const earlier = agentNotesByAgent(lines, () => ({ at: 50, taskId: 't-9' }));
    expect(earlier[0]).toMatchObject({ placement: 'undecidable', latestAt: 100 });
    expect(earlier[0]?.taskId).toBeUndefined();
  });

  it('caps the lines per agent and counts the rest', () => {
    const lines = [1, 2, 3, 4, 5].map((i) => line({ at: i, text: `n${i}` }));
    const [view] = agentNotesByAgent(lines, undefined, 2);
    expect(view?.notes.map((n) => n.text)).toEqual(['n5', 'n4']);
    expect(view?.more).toBe(3);
  });
});

describe('parseWithheld', () => {
  const now = 10 * AT_PAST_MS;

  it('accepts a bare declaration and stamps it with the server clock', () => {
    expect(parseWithheld({ withheld: true }, now)).toEqual({ ok: true, at: now });
  });

  it('keeps a hook clock inside the window and a short sessionId', () => {
    expect(parseWithheld({ withheld: true, at: now - 1000, sessionId: 's-1' }, now)).toEqual({
      ok: true,
      at: now - 1000,
      sessionId: 's-1',
    });
    // Outside the window the server clock stands in, as for any note.
    expect(parseWithheld({ withheld: true, at: 0 }, now)).toEqual({ ok: true, at: now });
  });

  it('refuses a declaration that carries the words it withholds', () => {
    expect(parseWithheld({ withheld: true, text: 'a private sentence' }, now)).toMatchObject({
      ok: false,
      error: 'withheld-with-text',
    });
  });

  it('refuses a malformed clock or session', () => {
    expect(parseWithheld({ withheld: true, at: 'noon' }, now)).toMatchObject({ error: 'bad-at' });
    expect(parseWithheld({ withheld: true, sessionId: 'x'.repeat(201) }, now)).toMatchObject({
      error: 'bad-session',
    });
  });
});
