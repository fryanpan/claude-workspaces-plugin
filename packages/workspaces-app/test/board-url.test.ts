import { describe, expect, it } from 'vitest';
import {
  type BoardLocation,
  buildBoardUrl,
  goalShareUrl,
  historyStep,
  libraryHref,
  libraryPlaceOf,
  parseBoardLocation,
  resourceOf,
  taskOfItemKey,
  taskShareUrl,
} from '../src/board/board-url.ts';

const at = (over: Partial<BoardLocation>): BoardLocation => ({
  nav: 'tasks',
  task: null,
  goal: null,
  thread: null,
  item: null,
  archived: false,
  tab: null,
  settings: null,
  ...over,
});

describe('parseBoardLocation', () => {
  it('reads the bare workspace path as the board with nothing open', () => {
    expect(parseBoardLocation('/workspaces/w1', '')).toEqual(at({}));
  });

  it('reads the nav suffix', () => {
    expect(parseBoardLocation('/workspaces/w1/home', '').nav).toBe('home');
    expect(parseBoardLocation('/workspaces/w1/library', '').nav).toBe('library');
    expect(parseBoardLocation('/workspaces/w1/activity', '').nav).toBe('activity');
  });

  it('reads an open task, with the thread it is aimed at', () => {
    expect(parseBoardLocation('/workspaces/w1', '?task=t1&thread=th1')).toEqual(
      at({ task: 't1', thread: 'th1' }),
    );
  });

  it('reads an open goal', () => {
    expect(parseBoardLocation('/workspaces/w1', '?goal=g1')).toEqual(at({ goal: 'g1' }));
  });

  it('task wins when both task and goal are present', () => {
    const loc = parseBoardLocation('/workspaces/w1', '?task=t1&goal=g1');
    expect(loc.task).toBe('t1');
    expect(loc.goal).toBeNull();
  });

  it('ignores a thread with no panel to aim inside', () => {
    expect(parseBoardLocation('/workspaces/w1', '?thread=th1').thread).toBeNull();
  });

  it('reads the walkthrough item on Home, and only on Home', () => {
    expect(parseBoardLocation('/workspaces/w1/home', '?item=doc-thread%3Ad1%3At9').item).toBe(
      'doc-thread:d1:t9',
    );
    expect(parseBoardLocation('/workspaces/w1', '?item=doc-thread%3Ad1%3At9').item).toBeNull();
  });

  it('reads the archived filter', () => {
    expect(parseBoardLocation('/workspaces/w1', '?view=archived').archived).toBe(true);
  });
});

describe('the places inside a tab', () => {
  it('reads a tab only on a task panel, and only a tab that exists', () => {
    expect(parseBoardLocation('/workspaces/w1', '?tab=activity').tab).toBeNull();
    expect(parseBoardLocation('/workspaces/w1', '?task=t1&tab=activity').tab).toBe('activity');
    expect(parseBoardLocation('/workspaces/w1', '?task=t1&tab=nope').tab).toBeNull();
  });

  it('reads no settings pane that does not exist', () => {
    expect(parseBoardLocation('/workspaces/w1', '?settings=nope').settings).toBeNull();
  });

  it('keeps the Library inner page on the Library and drops it elsewhere', () => {
    const search = '?list=files&place=doc';
    expect(buildBoardUrl('w1', at({ nav: 'library' }), search)).toBe(
      '/workspaces/w1/library?list=files&place=doc',
    );
    expect(buildBoardUrl('w1', at({ nav: 'home' }), search)).toBe('/workspaces/w1/home');
  });

  it('writes a Library inner page over the last one, and reads it back', () => {
    const here = 'https://board.test/workspaces/w1/library?list=files&as=me';
    expect(libraryHref(here, null, 'doc')).toBe('/workspaces/w1/library?as=me&place=doc');
    expect(libraryHref(here, null, null)).toBe('/workspaces/w1/library?as=me');
    expect(libraryPlaceOf('?list=files')).toEqual({ list: 'files', place: null });
  });

  it('makes settings a place Back returns from, and a pane change no entry', () => {
    expect(historyStep(at({}), at({ settings: 'board' }))).toBe('push');
    expect(historyStep(at({ settings: 'board' }), at({ settings: 'prompts' }))).toBe('replace');
    expect(historyStep(at({ settings: 'board' }), at({}))).toBe('close');
    expect(historyStep(at({ task: 't1', settings: 'board' }), at({ task: 't1' }))).toBe('close');
  });

  it('makes a panel tab a rewrite of the same panel', () => {
    expect(historyStep(at({ task: 't1' }), at({ task: 't1', tab: 'activity' }))).toBe('replace');
  });
});

describe('buildBoardUrl', () => {
  it('round-trips every field', () => {
    const cases: BoardLocation[] = [
      at({}),
      at({ nav: 'home' }),
      at({ task: 't1' }),
      at({ task: 't1', thread: 'th1' }),
      at({ goal: 'g1', thread: 'th2' }),
      at({ nav: 'home', item: 'task-thread:task:t1:th' }),
      at({ archived: true }),
      at({ task: 't1', tab: 'activity' }),
      at({ settings: 'board' }),
      at({ settings: 'notifications' }),
      at({ settings: 'prompts' }),
      at({ settings: 'list' }),
      at({ task: 't1', settings: 'board' }),
    ];
    for (const loc of cases) {
      const url = buildBoardUrl('w1', loc);
      const [pathname, search = ''] = url.split('?');
      expect(parseBoardLocation(pathname as string, search ? `?${search}` : '')).toEqual(loc);
    }
  });

  it('builds the bare board path with no dangling separators', () => {
    expect(buildBoardUrl('w1', at({}))).toBe('/workspaces/w1');
    expect(buildBoardUrl('w1', at({ nav: 'home' }))).toBe('/workspaces/w1/home');
  });

  it('encodes ids', () => {
    expect(buildBoardUrl('w 1', at({ task: 't/1' }))).toBe('/workspaces/w%201?task=t%2F1');
  });

  it('carries the identity override through, and nothing else', () => {
    const url = buildBoardUrl('w1', at({ task: 't1' }), '?as=bryan&walk=1&then=w2&stray=x');
    expect(url).toContain('as=bryan');
    expect(url).toContain('task=t1');
    expect(url).not.toContain('walk=');
    expect(url).not.toContain('then=');
    expect(url).not.toContain('stray=');
  });
});

describe('resourceOf', () => {
  it('names the open panel, task first', () => {
    expect(resourceOf(at({}))).toBeNull();
    expect(resourceOf(at({ task: 't1' }))).toBe('task:t1');
    expect(resourceOf(at({ goal: 'g1' }))).toBe('goal:g1');
    expect(resourceOf(at({ task: 't1', goal: 'g1' }))).toBe('task:t1');
  });

  it('names the walkthrough as one resource whatever item it is on', () => {
    expect(resourceOf(at({ nav: 'home', item: 'a' }))).toBe('walk');
    expect(resourceOf(at({ nav: 'home', item: 'b' }))).toBe('walk');
  });

  it('a panel opened over the walkthrough is the resource', () => {
    expect(resourceOf(at({ nav: 'home', item: 'a', task: 't1' }))).toBe('task:t1');
  });
});

describe('historyStep', () => {
  it('opening a resource is a navigation', () => {
    expect(historyStep(at({}), at({ task: 't1' }))).toBe('push');
    expect(historyStep(at({}), at({ goal: 'g1' }))).toBe('push');
    expect(historyStep(at({ nav: 'home' }), at({ nav: 'home', item: 'k' }))).toBe('push');
  });

  it('moving between resources is a navigation', () => {
    expect(historyStep(at({ task: 't1' }), at({ task: 't2' }))).toBe('push');
    expect(historyStep(at({ task: 't1' }), at({ goal: 'g1' }))).toBe('push');
  });

  it('changing nav destination is a navigation', () => {
    expect(historyStep(at({}), at({ nav: 'home' }))).toBe('push');
    expect(historyStep(at({ task: 't1' }), at({ nav: 'library', task: 't1' }))).toBe('push');
  });

  it('refining the open resource rewrites the entry instead of adding one', () => {
    expect(historyStep(at({ task: 't1' }), at({ task: 't1', thread: 'th' }))).toBe('replace');
    expect(historyStep(at({ nav: 'home', item: 'a' }), at({ nav: 'home', item: 'b' }))).toBe(
      'replace',
    );
    expect(historyStep(at({}), at({ archived: true }))).toBe('replace');
    expect(historyStep(at({}), at({}))).toBe('replace');
  });

  it('closing the open resource unwinds', () => {
    expect(historyStep(at({ task: 't1' }), at({}))).toBe('close');
    expect(historyStep(at({ nav: 'home', item: 'a' }), at({ nav: 'home' }))).toBe('close');
  });

  it('closing while changing nav is a navigation, not an unwind', () => {
    // Tapping Home while the walkthrough is up on the board side has no such
    // path today, but a nav change always makes a new place — Back should
    // return to the old nav with its resource still open.
    expect(historyStep(at({ task: 't1' }), at({ nav: 'home' }))).toBe('push');
  });
});

describe('share URLs', () => {
  it('a task link is the bare board path plus ?task=, whatever page it is copied from', () => {
    expect(taskShareUrl('http://mac.local:8787', 'w1', 't1')).toBe(
      'http://mac.local:8787/workspaces/w1?task=t1',
    );
  });

  it('a goal link is the bare board path plus ?goal=', () => {
    expect(goalShareUrl('http://mac.local:8787', 'w1', 'g1')).toBe(
      'http://mac.local:8787/workspaces/w1?goal=g1',
    );
  });
});

describe('taskOfItemKey', () => {
  it('reads the task from a ticket item, a ticket decision and a task thread', () => {
    expect(taskOfItemKey('task-review:t-1:r-2')).toEqual({ taskId: 't-1', threadId: null });
    expect(taskOfItemKey('decision:t-1')).toEqual({ taskId: 't-1', threadId: null });
    expect(taskOfItemKey('task-thread:task:t-1:th-9')).toEqual({ taskId: 't-1', threadId: 'th-9' });
  });
  it('is null for a doc thread, a goal thread and a malformed key', () => {
    expect(taskOfItemKey('doc-thread:d-1:th-1')).toBeNull();
    expect(taskOfItemKey('goal-thread:goal:g-1:th-1')).toBeNull();
    expect(taskOfItemKey('task-review:t-1')).toBeNull();
    expect(taskOfItemKey('')).toBeNull();
  });
});
