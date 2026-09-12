import { initDocMeta } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  HEADING_IN_VIEW_CLASS,
  formatHeadingWhen,
  isMeetingMeta,
  mountDocHeading,
  mountMeetingHeading,
} from '../src/doc/doc-heading.ts';

/**
 * A meeting's title as the heading of its page.
 *
 * Driven over a real Y.Doc, because the heading's whole job is to paint what
 * the synced meta says — the title, who chose it, when the doc was created —
 * and to follow it when the server writes a new name. The layout half (it is
 * the most prominent thing at the top, at 1180x820 and 430) is read off a real
 * browser on staging; happy-dom lays nothing out.
 */

const CREATED = new Date(2026, 8, 12, 12, 41).getTime();
const TOPIC = 'Berth extension permit and crew schedule';

describe('the meeting heading', () => {
  let editor: HTMLElement;
  let ydoc: Y.Doc;
  let cleanups: Array<() => void>;
  let sent: Array<{ url: string; title: string }>;
  let inView: ((v: boolean) => void) | undefined;
  let clock: number;

  const seed = (title: string, titleSource?: 'default' | 'auto' | 'person') => {
    initDocMeta(ydoc, {
      docId: 'd-berth',
      type: 'markdown',
      createdAt: CREATED,
      title,
      huddle: true,
      ...(titleSource ? { titleSource } : {}),
    });
  };
  const mount = (over: Partial<Parameters<typeof mountDocHeading>[0]> = {}) =>
    mountDocHeading({
      editorMount: editor,
      ydoc,
      docId: 'd-berth',
      canWrite: true,
      listen: (t, type, h) => t.addEventListener(type, h),
      onCleanup: (fn) => cleanups.push(fn),
      now: () => clock,
      send: async (url, title) => {
        sent.push({ url, title });
        return true;
      },
      observeInView: (_el, _root, cb) => {
        inView = cb;
        return () => {
          inView = undefined;
        };
      },
      ...over,
    });
  const titleEl = () => editor.querySelector<HTMLElement>('.doc-heading-title');
  const whenEl = () => editor.querySelector<HTMLElement>('.doc-heading-when');

  beforeEach(() => {
    editor = document.createElement('div');
    editor.id = 'editor';
    editor.innerHTML = '<div class="ProseMirror"></div>';
    document.body.replaceChildren(editor);
    ydoc = new Y.Doc();
    cleanups = [];
    sent = [];
    clock = CREATED + 5 * 60_000;
  });

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it('is the first thing in the scroller, ahead of the notes', () => {
    seed('Meeting', 'default');
    mount().onSynced();
    expect(editor.firstElementChild?.classList.contains('doc-heading')).toBe(true);
    expect(titleEl()?.tagName).toBe('H1');
    expect(titleEl()?.textContent).toBe('Meeting');
  });

  it('shows the default title as a placeholder, and the topic as a name once it lands', () => {
    seed('Meeting', 'default');
    mount().onSynced();
    expect(titleEl()?.classList.contains('is-pending')).toBe(true);

    // The server's namer writes the topic into the synced meta.
    ydoc.getMap('meta').set('title', TOPIC);
    ydoc.getMap('meta').set('titleSource', 'auto');
    expect(titleEl()?.textContent).toBe(TOPIC);
    expect(titleEl()?.classList.contains('is-pending')).toBe(false);
    expect(titleEl()?.classList.contains('is-arriving')).toBe(true);
  });

  it('shows a title from before titleSource as an ordinary name', () => {
    seed('Meeting notes 2026-09-03 10:15');
    mount().onSynced();
    expect(titleEl()?.textContent).toBe('Meeting notes 2026-09-03 10:15');
    expect(titleEl()?.classList.contains('is-pending')).toBe(false);
  });

  it('names nothing before the doc has synced', () => {
    mount();
    expect(titleEl()?.textContent).toBe('');
    expect(whenEl()?.textContent).toBe('');
  });

  it('says when the doc was created, and when it last changed from the server record', () => {
    seed('Meeting', 'default');
    const heading = mount({ lastActivityAt: CREATED + 3 * 60 * 60_000 });
    heading.onSynced();
    const text = whenEl()?.textContent ?? '';
    expect(text).toBe(formatHeadingWhen(CREATED, CREATED + 3 * 60 * 60_000, clock));
    expect(text).toContain('12');
    expect(text).toContain('Modified');
  });

  it('moves Modified forward on an edit after the sync, not on the sync itself', () => {
    seed('Meeting', 'default');
    const heading = mount();
    // The first sync lands as updates; they are the doc arriving.
    heading.onSynced();
    expect(whenEl()?.textContent).not.toContain('Modified');

    clock = CREATED + 90 * 60_000;
    const prose = ydoc.getXmlFragment('prose');
    prose.insert(0, [new Y.XmlText('The berth extension needs the county permit')]);
    expect(whenEl()?.textContent).toBe(formatHeadingWhen(CREATED, clock, clock));
    expect(whenEl()?.textContent).toContain('Modified');
  });

  it('renames from the heading and marks the name chosen', async () => {
    seed('Meeting', 'default');
    mount().onSynced();
    const h1 = titleEl();
    if (!h1) throw new Error('no heading');
    h1.click();
    expect(h1.hasAttribute('contenteditable')).toBe(true);
    h1.textContent = 'Crane hire';
    h1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      { url: expect.stringContaining('docs/d-berth/title'), title: 'Crane hire' },
    ]);
    // What was typed stays on screen until the server's write echoes back.
    expect(h1.textContent).toBe('Crane hire');
    expect(h1.classList.contains('is-pending')).toBe(false);
  });

  it('is not editable for a reader who cannot write', () => {
    seed('Meeting', 'default');
    mount({ canWrite: false }).onSynced();
    titleEl()?.click();
    expect(titleEl()?.hasAttribute('contenteditable')).toBe(false);
  });

  it('empties the crumb only while the heading is on screen', () => {
    seed('Meeting', 'default');
    mount().onSynced();
    inView?.(true);
    expect(document.body.classList.contains(HEADING_IN_VIEW_CLASS)).toBe(true);
    inView?.(false);
    expect(document.body.classList.contains(HEADING_IN_VIEW_CLASS)).toBe(false);
    inView?.(true);
    for (const fn of cleanups.splice(0)) fn();
    expect(document.body.classList.contains(HEADING_IN_VIEW_CLASS)).toBe(false);
    expect(editor.querySelector('.doc-heading')).toBeNull();
  });
});

describe('mountMeetingHeading', () => {
  const scope = { listen: () => {}, onCleanup: () => {} };
  const run = (meta: { huddle?: boolean; alias?: string }, huddle: boolean) => {
    const editor = document.createElement('div');
    const ydoc = new Y.Doc();
    let synced: (() => void) | undefined;
    mountMeetingHeading({
      editorMount: editor,
      ydoc,
      docId: 'd-x',
      canWrite: true,
      huddle,
      whenSynced: (cb) => {
        synced = cb;
      },
      scope,
      observeInView: () => () => {},
    });
    const before = editor.querySelector('.doc-heading') !== null;
    initDocMeta(ydoc, {
      docId: 'd-x',
      type: 'markdown',
      createdAt: CREATED,
      title: 'Meeting',
      ...meta,
    });
    synced?.();
    return { before, after: editor.querySelector('.doc-heading') !== null };
  };

  it('mounts at once on a huddle, on the first sync for a calendar meeting, and never on another doc', () => {
    expect(run({ huddle: true }, true)).toEqual({ before: true, after: true });
    expect(run({ alias: 'meeting-20260912-1241-abcd' }, false)).toEqual({
      before: false,
      after: true,
    });
    expect(run({}, false)).toEqual({ before: false, after: false });
    expect(isMeetingMeta({ alias: 'plan-notes' })).toBe(false);
  });
});

describe('formatHeadingWhen', () => {
  it('leaves Modified off within the minute the doc was created', () => {
    expect(formatHeadingWhen(CREATED, CREATED + 20_000, CREATED)).not.toContain('Modified');
    expect(formatHeadingWhen(CREATED, undefined, CREATED)).not.toContain('Modified');
  });

  it('names the day when the change was on another day, and the year when it is not this one', () => {
    const nextDay = CREATED + 26 * 60 * 60_000;
    const text = formatHeadingWhen(CREATED, nextDay, nextDay);
    expect(text.split('·').length).toBe(4);
    expect(formatHeadingWhen(CREATED, undefined, new Date(2027, 1, 1).getTime())).toContain('2026');
  });
});
