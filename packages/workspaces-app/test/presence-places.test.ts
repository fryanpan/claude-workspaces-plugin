/**
 * Which participants share the reader's page and which share only the
 * workspace, and what each row of the strip's list says about where they are
 * (`presence-places.ts`).
 */
import { AGENT_SPOTS_FIELD, PERSON_SPOT_FIELD } from '@claude-workspaces/core/workspace-presence';
import { describe, expect, it } from 'vitest';
import type { PresenceChip } from '../src/board/board-presence-model.ts';
import {
  PAGE_TITLE_FIELD,
  placeChips,
  samePlace,
  spotLabel,
  titlesFromStates,
} from '../src/presence/presence-places.ts';

const WS = '/workspaces/w-1';
const SELF = 1;

const states = new Map<number, unknown>([
  [
    SELF,
    { user: { id: 'me', name: 'Alice' }, [PERSON_SPOT_FIELD]: { surface: 'doc', docId: 'quay' } },
  ],
  [
    2,
    {
      user: { id: 'bob', name: 'Bob' },
      [PERSON_SPOT_FIELD]: { surface: 'doc', docId: 'quay', blockId: 'b1', quote: 'High tide' },
    },
  ],
  [
    3,
    {
      user: { id: 'cam', name: 'Riverbend' },
      [PERSON_SPOT_FIELD]: { surface: 'doc', docId: 'plan' },
      [PAGE_TITLE_FIELD]: 'Riverbend launch plan',
    },
  ],
  [
    4,
    {
      user: { id: 'dee', name: 'Saltmarsh' },
      [PERSON_SPOT_FIELD]: { surface: 'board', path: `${WS}/library` },
    },
  ],
  [
    99,
    {
      [AGENT_SPOTS_FIELD]: {
        'agent-lead': { surface: 'doc', docId: 'plan', name: 'Harborlight', seq: 3 },
      },
    },
  ],
]);

const chip = (key: string, label: string, kind: 'person' | 'agent' = 'person'): PresenceChip => ({
  key,
  label,
  kind,
  where: '',
  title: label,
});

describe('samePlace', () => {
  it('is one page for one doc, and two for two docs', () => {
    expect(samePlace({ surface: 'doc', docId: 'a' }, { surface: 'doc', docId: 'a' })).toBe(true);
    expect(samePlace({ surface: 'doc', docId: 'a' }, { surface: 'doc', docId: 'b' })).toBe(false);
    expect(samePlace({ surface: 'doc', docId: 'a' }, { surface: 'mock', docId: 'a' })).toBe(false);
  });

  it('is one page for one board tab, whatever panel is open on it', () => {
    const tasks = { surface: 'board' as const, path: WS };
    expect(samePlace(tasks, { surface: 'board', path: `${WS}/tasks?task=t-1` })).toBe(true);
    expect(samePlace(tasks, { surface: 'board', path: `${WS}/library` })).toBe(false);
    // A board spot that names no tab is on whichever tab the other one is.
    expect(samePlace(tasks, { surface: 'board' })).toBe(true);
  });
});

describe('spotLabel', () => {
  it('names a board tab, a titled doc, and an untitled one by its kind', () => {
    const titles = new Map([['plan', 'Riverbend launch plan']]);
    expect(spotLabel({ surface: 'board', path: `${WS}/activity` }, titles)).toBe('Activity');
    expect(spotLabel({ surface: 'board' }, titles)).toBe('Tasks');
    expect(spotLabel({ surface: 'doc', docId: 'plan' }, titles)).toBe('Riverbend launch plan');
    expect(spotLabel({ surface: 'doc', docId: 'x' }, titles)).toBe('a doc');
    expect(spotLabel({ surface: 'whiteboard', docId: 'x' }, titles)).toBe('a whiteboard');
  });
});

describe('titlesFromStates', () => {
  it('reads each page’s announced title by the doc it is on', () => {
    expect([...titlesFromStates(states)]).toEqual([['plan', 'Riverbend launch plan']]);
  });
});

describe('placeChips', () => {
  const placed = placeChips(
    [
      { ...chip('p-me', 'Alice (you)'), self: true },
      chip('p-bob', 'Bob'),
      chip('p-cam', 'Riverbend'),
      chip('p-dee', 'Saltmarsh'),
      chip('a-agent-lead', 'Harborlight', 'agent'),
      chip('a-agent-quiet', 'Quiet', 'agent'),
    ],
    { states, selfClientId: SELF, mine: { surface: 'doc', docId: 'quay' } },
  );
  const view = placed.map((c) => [c.label, c.here, c.line]);

  it('puts the people on the reader’s page under here, and says what they are at', () => {
    expect(view[1]).toEqual(['Bob', true, 'At “High tide”']);
  });

  it('puts everyone else under elsewhere, with the page they are on', () => {
    expect(view[2]).toEqual(['Riverbend', false, 'On Riverbend launch plan']);
    expect(view[3]).toEqual(['Saltmarsh', false, 'On Library']);
    // The agent's page title comes from a person on that page.
    expect(view[4]).toEqual(['Harborlight', false, 'On Riverbend launch plan']);
  });

  it('puts an agent that has pointed nowhere under elsewhere, and leaves the reader alone', () => {
    expect(view[5]).toEqual(['Quiet', false, 'Not pointing at anything']);
    expect(placed[0]).toEqual({ ...chip('p-me', 'Alice (you)'), self: true });
  });

  it('moves a person to here once the reader is on their page', () => {
    const onPlan = placeChips([chip('p-cam', 'Riverbend')], {
      states,
      selfClientId: SELF,
      mine: { surface: 'doc', docId: 'plan' },
    });
    expect(onPlan[0]?.here).toBe(true);
    // The group heading already says "here"; the row names the page.
    expect(onPlan[0]?.line).toBe('On Riverbend launch plan');
    expect(onPlan[0]?.page).toBe('Riverbend launch plan');
    expect(onPlan[0]?.place).toBe('On Riverbend launch plan');
  });
});
