/**
 * Home's "Not on a task" list: end-of-turn notes no task took, one group per
 * agent, headed by the state they are in.
 *
 * The model cases pin what each state SAYS and what the list leaves out; the
 * island cases mount the real pane and read what a person sees — that the two
 * no-task causes do not read alike, and that a header opens a task only when
 * there is one. The server half is
 * `packages/server/test/board-agent-notes.test.ts`.
 *
 * All fixtures are synthetic — invented agents, short fake ids.
 */
import type { User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_WINDOW_MS } from '../src/board/activity-model.ts';
import {
  type AgentNotesWire,
  agentNoteGroups,
  parseAgentNotes,
  statePhrase,
} from '../src/board/agent-notes-model.ts';
import type { BoardTask } from '../src/board/board-model.ts';
import {
  ACTIVITY_EMPTY,
  homeActivityData,
  mountHomeActivityIsland,
} from '../src/board/home-activity-island.tsx';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const ME: User = { id: 'u-me', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const tick = () => new Promise((r) => setTimeout(r, 0));

function wire(over: Partial<AgentNotesWire>): AgentNotesWire {
  return {
    agent: 'Harborlight',
    placement: 'undecidable',
    latestAt: NOW - 2 * MIN,
    notes: [{ at: NOW - 2 * MIN, kind: 'turn', text: 'Merged the index half.\n\nDetails below.' }],
    more: 0,
    ...over,
  };
}

function task(id: string, title: string): BoardTask {
  return {
    id,
    title,
    status: 'in-progress',
    assignee: 'Harborlight',
    goal: 'g-1',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW - 60 * MIN,
  };
}

describe('agentNoteGroups', () => {
  it('says why each group has no task, and the two no-task causes read differently', () => {
    const groups = agentNoteGroups(
      [
        wire({ agent: 'Harborlight', placement: 'undecidable' }),
        wire({ agent: 'Riverbend', placement: 'unattachable', latestAt: NOW - MIN }),
      ],
      [],
      NOW,
    );
    expect(groups.map((g) => [g.agent, g.state])).toEqual([
      ['Riverbend', 'held no task, so there was nothing to put this on'],
      ['Harborlight', 'held several tasks, so no one task took this'],
    ]);
    // Each line is the note's first prose line, as a task group's is.
    expect(groups[1]?.notes.map((n) => n.text)).toEqual(['Merged the index half.']);
  });

  it('names the task an attached agent went to, and drops it once nothing unplaced is left', () => {
    const tasks = [task('t-9', 'Wire the index')];
    const [g] = agentNoteGroups([wire({ placement: 'attached', taskId: 't-9' })], tasks, NOW);
    expect(g?.taskId).toBe('t-9');
    // The listed notes are NOT on that task: the state says so, and names
    // the task only as where the newest one went.
    expect(g?.state).toBe('this earlier note went nowhere; the latest is on “Wire the index”');
    expect(
      agentNoteGroups([wire({ placement: 'attached', taskId: 't-9', notes: [] })], tasks, NOW),
    ).toEqual([]);
  });

  it('leaves out an agent whose latest note is older than the pane window', () => {
    const old = NOW - ACTIVITY_WINDOW_MS - MIN;
    expect(
      agentNoteGroups(
        [wire({ latestAt: old, notes: [{ at: old, kind: 'turn', text: 'x' }] })],
        [],
        NOW,
      ),
    ).toEqual([]);
  });

  it('caps the lines at three and counts the rest, including what the server held back', () => {
    const notes = [1, 2, 3, 4].map((i) => ({
      at: NOW - i * MIN,
      kind: 'turn' as const,
      text: `n${i}`,
    }));
    const [g] = agentNoteGroups([wire({ notes, more: 5 })], [], NOW);
    expect(g?.notes.map((n) => n.text)).toEqual(['n1', 'n2', 'n3']);
    expect(g?.more).toBe(6);
  });

  it('does not count what the server held back once some notes fell out of the window', () => {
    const notes = [
      { at: NOW - MIN, kind: 'turn' as const, text: 'inside' },
      { at: NOW - ACTIVITY_WINDOW_MS - MIN, kind: 'turn' as const, text: 'outside' },
    ];
    const [g] = agentNoteGroups([wire({ notes, latestAt: NOW - MIN, more: 4 })], [], NOW);
    expect(g?.notes.map((n) => n.text)).toEqual(['inside']);
    expect(g?.more).toBe(0);
  });
});

describe('the words and ages a group shows', () => {
  it('says this for one note and these for several', () => {
    expect(statePhrase('undecidable', undefined, 1)).toBe(
      'held several tasks, so no one task took this',
    );
    expect(statePhrase('undecidable', undefined, 2)).toBe(
      'held several tasks, so no one task took these',
    );
    expect(statePhrase('unattachable', undefined, 3)).toBe(
      'held no task, so there was nothing to put these on',
    );
    expect(statePhrase('attached', 'Wire the index', 2)).toBe(
      'these earlier notes went nowhere; the latest is on “Wire the index”',
    );
    expect(statePhrase('attached', undefined, 1)).toBe(
      'this earlier note went nowhere; the latest is on a task',
    );
  });

  it('dates the header by the newest LISTED note, not by the placed one', () => {
    const [g] = agentNoteGroups(
      [
        wire({
          placement: 'attached',
          taskId: 't-9',
          latestAt: NOW - MIN,
          notes: [
            { at: NOW - 20 * MIN, kind: 'turn', text: 'a' },
            { at: NOW - 30 * MIN, kind: 'turn', text: 'b' },
          ],
        }),
      ],
      [task('t-9', 'Wire the index')],
      NOW,
    );
    expect(g?.age).toBe('20m');
  });

  it('shows a one-note group’s age once, in the header', () => {
    const [one] = agentNoteGroups([wire({})], [], NOW);
    expect(one?.age).toBe('2m');
    expect(one?.notes[0]?.age).toBe('');
    const notes = [1, 2].map((i) => ({ at: NOW - i * MIN, kind: 'turn' as const, text: `n${i}` }));
    const [two] = agentNoteGroups([wire({ notes })], [], NOW);
    expect(two?.notes.map((n) => n.age)).toEqual(['1m', '2m']);
  });

  it('keeps each note’s whole text beside its first line', () => {
    const [g] = agentNoteGroups([wire({})], [], NOW);
    expect(g?.notes[0]?.text).toBe('Merged the index half.');
    expect(g?.notes[0]?.full).toBe('Merged the index half.\n\nDetails below.');
  });
});

describe('parseAgentNotes', () => {
  it('drops malformed agents and notes rather than drawing half of one', () => {
    const parsed = parseAgentNotes({
      agents: [
        wire({}),
        { agent: 'Riverbend', placement: 'confused', latestAt: 1, notes: [] },
        { agent: '', placement: 'unattachable', latestAt: 1, notes: [] },
        {
          ...wire({ agent: 'Saltmarsh' }),
          notes: [
            { at: 1, kind: 'shout', text: 'x' },
            { at: 2, kind: 'turn', text: 'kept' },
          ],
        },
      ],
    });
    expect(parsed.map((a) => a.agent)).toEqual(['Harborlight', 'Saltmarsh']);
    expect(parsed[1]?.notes.map((n) => n.text)).toEqual(['kept']);
    expect(parseAgentNotes(null)).toEqual([]);
    expect(parseAgentNotes({ agents: 'no' })).toEqual([]);
  });
});

describe('the Not on a task list in the Home pane', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount(agentNotes: AgentNotesWire[], tasks: BoardTask[] = []) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenTask = vi.fn();
    homeActivityData.value = { tasks, goals: [], now: NOW, agentNotes };
    const unmount = mountHomeActivityIsland(
      host,
      {
        onOpenTask,
        onComment: vi.fn().mockResolvedValue(null),
        onReply: vi.fn().mockResolvedValue(null),
      },
      ME,
    );
    return { host, onOpenTask, unmount };
  }

  it('shows a busy agent’s note and an idle agent’s note under their agents, each with its reason', () => {
    const { host, unmount } = mount([
      wire({ agent: 'Harborlight', placement: 'undecidable' }),
      wire({
        agent: 'Riverbend',
        placement: 'unattachable',
        notes: [{ at: NOW - 3 * MIN, kind: 'turn', text: 'Parked on the retention call.' }],
        latestAt: NOW - 3 * MIN,
      }),
    ]);
    expect(host.querySelector('.acti-subhead')?.textContent).toBe('Not on a task');
    expect(host.textContent).not.toContain(ACTIVITY_EMPTY);
    const byAgent = new Map(
      [...host.querySelectorAll<HTMLElement>('.acti-agent-group')].map((g) => [g.dataset.agent, g]),
    );
    const busy = byAgent.get('Harborlight');
    const idle = byAgent.get('Riverbend');
    expect(busy?.querySelector('.acti-agent-name')?.textContent).toBe('Harborlight');
    expect(busy?.querySelector('.acti-state')?.textContent).toBe(statePhrase('undecidable'));
    expect(busy?.querySelector('.board-activity-note')?.textContent).toContain(
      'Merged the index half.',
    );
    expect(idle?.querySelector('.acti-state')?.textContent).toBe(statePhrase('unattachable'));
    expect(idle?.querySelector('.board-activity-note')?.textContent).toContain(
      'Parked on the retention call.',
    );
    // Neither header is a control: there is no task to open.
    expect(busy?.querySelector('.acti-head')?.tagName).toBe('DIV');
    expect(idle?.querySelector('.acti-head')?.tagName).toBe('DIV');
    expect(busy?.querySelector('.acti-open')).toBeNull();
    unmount();
  });

  it('opens the task when the agent’s latest note went to one', async () => {
    const { host, onOpenTask, unmount } = mount(
      [wire({ placement: 'attached', taskId: 't-9' })],
      [task('t-9', 'Wire the index')],
    );
    const head = host.querySelector<HTMLButtonElement>('.acti-agent-group button.acti-head');
    expect(head).not.toBeNull();
    // The one header that opens something says so with a chevron.
    expect(head?.querySelector('.acti-open')).not.toBeNull();
    head?.click();
    await tick();
    expect(onOpenTask).toHaveBeenCalledWith('t-9');
    unmount();
  });

  it('expands a note in place to its whole text, and folds it back', async () => {
    const long = `${'word '.repeat(60)}end of the first line.\n\nThe second paragraph.`;
    const { host, unmount } = mount([
      wire({ notes: [{ at: NOW - 2 * MIN, kind: 'turn', text: long }] }),
    ]);
    const line = host.querySelector<HTMLButtonElement>(
      '.acti-agent-group button.board-activity-note',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('aria-expanded')).toBe('false');
    expect(line?.textContent).not.toContain('The second paragraph.');
    line?.click();
    await tick();
    expect(line?.getAttribute('aria-expanded')).toBe('true');
    expect(line?.classList.contains('acti-note-open')).toBe(true);
    expect(line?.textContent).toContain('The second paragraph.');
    line?.click();
    await tick();
    expect(line?.getAttribute('aria-expanded')).toBe('false');
    expect(line?.textContent).not.toContain('The second paragraph.');
    unmount();
  });

  it('still says nothing moved when there are no task groups and no agent groups', () => {
    const { host, unmount } = mount([]);
    expect(host.querySelector('.acti-subhead')).toBeNull();
    expect(host.textContent).toContain(ACTIVITY_EMPTY);
    unmount();
  });
});
