/**
 * The states an agent's end-of-turn notes can be in, named for the reader —
 * unit cases for `agent-note-placement.ts`. The route cases that drive the
 * same module through a server are `board-agent-notes.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { LoggedAgentNote } from '../src/agent-note-log.ts';
import { agentNotesByAgent, placementOfLogged } from '../src/agent-note-placement.ts';

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
  it('names the two states a log line can record, never the word "ambiguous"', () => {
    expect(placementOfLogged({ ambiguous: true })).toBe('undecidable');
    expect(placementOfLogged({ ambiguous: false })).toBe('unattachable');
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

  it('adds what the read already left out to the count', () => {
    const [view] = agentNotesByAgent(
      [line({ at: 1 })],
      undefined,
      10,
      new Map([['harborlight', 7]]),
    );
    expect(view?.more).toBe(7);
  });

  it('answers an empty list for an empty read', () => {
    expect(agentNotesByAgent([])).toEqual([]);
  });
});
