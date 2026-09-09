import { prose } from '@claude-workspaces/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import {
  RECENT_NOTE_MS,
  RECENT_NOTE_STEP_MS,
  noteLines,
  notesSectionStart,
  recentStep,
  recentTintChanged,
} from '../src/settle-wash.ts';

/**
 * The recent-note tint (settle-wash.ts): a REMOTE insert into the "Meeting
 * notes" section, while a meeting is live, decorates the arrived block with
 * `.recent-note` at step 0 — and nothing else does: not a local edit, not an insert
 * outside the section, not a doc with no meeting. Runs through the REAL
 * createEditor so the gate is tested against the same y-sync meta key the
 * Collaboration extension registers (the import-source trap editor.ts's
 * comment pins).
 */

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mountEditor(
  md: string,
  live: { on: boolean },
  onNotesInsert?: () => void,
  clock?: { now: number },
) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    settleWash: {
      isLive: () => live.on,
      ...(onNotesInsert ? { onNotesInsert } : {}),
      ...(clock ? { now: () => clock.now } : {}),
    },
  });
  open.push({ handle, parent });
  return { handle, parent, view: handle.editor.view as EditorView };
}

const DOC = '# Plan\n\nThe agenda paragraph.\n\n## Meeting notes\n\n- an earlier note\n';

/** Append one bullet at the end of the doc, flagged (or not) as remote. */
function appendNote(view: EditorView, text: string, remote: boolean): void {
  const { state } = view;
  const li = state.schema.nodes.listItem.create(
    null,
    state.schema.nodes.paragraph.create(null, state.schema.text(text)),
  );
  const list = state.schema.nodes.bulletList.create(null, li);
  let tr = state.tr.insert(state.doc.content.size, list);
  // The same key Collaboration registers under; a local keystroke never
  // carries this meta, which is the whole authorship signal.
  if (remote) tr = tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
  view.dispatch(tr);
}

/**
 * What the collaboration binding actually does with a remote update: ONE
 * replace of the whole document with the new content (y-tiptap's
 * `_typeChanged`). `edit` builds the new doc from the old one.
 */
function replaceWholeDoc(
  view: EditorView,
  edit: (doc: EditorView['state']['doc']) => Fragment,
): void {
  const { state } = view;
  const next = edit(state.doc);
  view.dispatch(
    state.tr
      .replace(0, state.doc.content.size, new Slice(next, 0, 0))
      .setMeta(ySyncPluginKey, { isChangeOrigin: true }),
  );
}

/** Index of the doc's last bulletList (a trailing empty paragraph follows it). */
function lastListIndex(doc: EditorView['state']['doc']): number {
  let at = -1;
  doc.forEach((n, _pos, i) => {
    if (n.type.name === 'bulletList') at = i;
  });
  if (at < 0) throw new Error('fixture: no list');
  return at;
}

const washed = (parent: HTMLElement): string[] =>
  [...parent.querySelectorAll<HTMLElement>('.recent-note')].map((el) => el.textContent ?? '');
const arrivals = (parent: HTMLElement): string[] =>
  [...parent.querySelectorAll<HTMLElement>('.recent-note')].map(
    (el) => el.getAttribute('data-at') ?? '',
  );
const ages = (parent: HTMLElement): string[] =>
  [...parent.querySelectorAll<HTMLElement>('.recent-note')].map(
    (el) => el.getAttribute('data-age') ?? '',
  );

describe('the fade steps', () => {
  it('is loudest for thirty seconds, then steps down, and is gone at two minutes', () => {
    expect(recentStep(0, 0)).toBe(0);
    expect(recentStep(0, RECENT_NOTE_STEP_MS - 1)).toBe(0);
    expect(recentStep(0, RECENT_NOTE_STEP_MS)).toBe(1);
    expect(recentStep(0, 3 * RECENT_NOTE_STEP_MS)).toBe(3);
    expect(recentStep(0, RECENT_NOTE_MS - 1)).toBe(3);
    expect(recentStep(0, RECENT_NOTE_MS)).toBeNull();
  });

  it('a line that just arrived carries step 0, and the re-band moves it on', () => {
    vi.useFakeTimers();
    try {
      const clock = { now: 1_000_000 };
      const { view, parent } = mountEditor(DOC, { on: true }, undefined, clock);
      appendNote(view, 'the freshly composed note', true);
      expect(ages(parent)).toEqual(['0']);
      // The instant it arrived rides on the tint too: four steps cannot say
      // "1m 15s", and the margin card needs to (recent-note-cards.ts).
      expect(arrivals(parent)).toEqual([String(clock.now)]);
      // Thirty seconds on: the timer the arrival armed re-bands the set.
      clock.now += RECENT_NOTE_STEP_MS;
      vi.advanceTimersByTime(RECENT_NOTE_STEP_MS);
      expect(ages(parent)).toEqual(['1']);
      // A second note arrives: each line keeps its own age.
      appendNote(view, 'a newer note', true);
      expect(ages(parent)).toEqual(['1', '0']);
      // Two minutes after the first: it is gone, the second is on step 3.
      clock.now += RECENT_NOTE_MS - RECENT_NOTE_STEP_MS;
      vi.advanceTimersByTime(RECENT_NOTE_MS - RECENT_NOTE_STEP_MS);
      expect(washed(parent)).toEqual(['a newer note']);
      expect(ages(parent)).toEqual(['3']);
      // …and once nothing is left, nothing is tinted.
      clock.now += RECENT_NOTE_MS;
      vi.advanceTimersByTime(RECENT_NOTE_MS);
      expect(washed(parent)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a caller watching the tint set re-counts on', () => {
  it('a remote note changes the tint set; a keystroke does not', () => {
    const { view } = mountEditor(DOC, { on: true });
    const before = view.state;
    appendNote(view, 'typed by a person', false);
    expect(recentTintChanged(before, view.state)).toBe(false);
    const mid = view.state;
    appendNote(view, 'the freshly composed note', true);
    expect(recentTintChanged(mid, view.state)).toBe(true);
  });
});

describe('the settle wash', () => {
  it('washes a remote insert into the notes section while the meeting is live', () => {
    let landed = 0;
    const { view, parent } = mountEditor(DOC, { on: true }, () => landed++);
    appendNote(view, 'the freshly composed note', true);
    const hits = washed(parent);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.join(' ')).toContain('the freshly composed note');
    // …and ONLY the arrived block, not the whole section.
    expect(hits.join(' ')).not.toContain('an earlier note');
    expect(landed).toBe(1);
  });

  it('washes ONLY the lines a whole-doc replace added — not the section it re-sent', () => {
    // Two notes already there, then the binding replaces the whole doc with
    // one that holds them both plus a third: the step map says everything
    // was inserted; the wash must say one line was.
    const { view, parent } = mountEditor(`${DOC}- a second earlier note\n`, { on: true });
    replaceWholeDoc(view, (doc) => {
      const { schema } = view.state;
      const li = schema.nodes.listItem.create(
        null,
        schema.nodes.paragraph.create(null, schema.text('the third, freshly composed')),
      );
      const at = lastListIndex(doc);
      const list = doc.child(at);
      const grown = list.copy(list.content.append(Fragment.from(li)));
      return doc.content.replaceChild(at, grown);
    });
    expect(washed(parent)).toEqual(['the third, freshly composed']);
  });

  it('a line the write CHANGED washes; its untouched neighbours do not', () => {
    const { view, parent } = mountEditor(`${DOC}- a second earlier note\n`, { on: true });
    replaceWholeDoc(view, (doc) => {
      const { schema } = view.state;
      const at = lastListIndex(doc);
      const list = doc.child(at);
      const reworded = schema.nodes.listItem.create(
        null,
        schema.nodes.paragraph.create(null, schema.text('a second earlier note, reworded')),
      );
      const items = list.copy(list.content.replaceChild(1, reworded));
      return doc.content.replaceChild(at, items);
    });
    expect(washed(parent)).toEqual(['a second earlier note, reworded']);
  });

  it('a local edit is never washed — the meta is the authorship signal', () => {
    const { view, parent } = mountEditor(DOC, { on: true });
    appendNote(view, 'typed by a person', false);
    expect(washed(parent)).toEqual([]);
  });

  it('a remote edit with no live meeting is never washed', () => {
    const { view, parent } = mountEditor(DOC, { on: false });
    appendNote(view, 'a collaborator, later', true);
    expect(washed(parent)).toEqual([]);
  });

  it('a remote insert ABOVE the notes section is never washed', () => {
    const { view, parent } = mountEditor(DOC, { on: true });
    const { state } = view;
    const p = state.schema.nodes.paragraph.create(null, state.schema.text('remote preamble'));
    // Position 0: before the title, well above the notes heading.
    view.dispatch(state.tr.insert(0, p).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    expect(washed(parent)).toEqual([]);
  });

  it('a doc with no "Meeting notes" heading washes nothing', () => {
    const { view, parent } = mountEditor('# Plan\n\nJust prose.\n', { on: true });
    appendNote(view, 'remote words', true);
    expect(washed(parent)).toEqual([]);
  });
});

describe('which "Meeting notes" heading the client reads as the section', () => {
  /**
   * The client and the server must answer this identically: both take the
   * LAST heading with that text. A doc carrying a person's own notes heading
   * plus a meeting's own is the shape where the two rules would diverge, and
   * a client that took the FIRST would show a reader lines the server has
   * stopped treating as notes.
   */
  const TWO =
    '## Meeting notes\n\n- a line under the first heading\n\n## Meeting notes\n\n- a line under the second\n';

  it('takes the last one, so the section is what the server says it is', () => {
    const { view } = mountEditor(TWO, { on: false });
    const at = notesSectionStart(view.state.doc);
    expect(at).not.toBeNull();
    const text = noteLines(view.state.doc)
      .map((l) => view.state.doc.textBetween(l.from, l.to, ' '))
      .join(' | ');
    expect(text).toContain('a line under the second');
    // The first heading's line is ABOVE the section, so it is not in it.
    expect(text).not.toContain('a line under the first');
  });

  it('MUTATION CONTROL: with one heading, that same line IS the section', () => {
    // Same words, one heading. If this failed too, the assertion above would
    // be reading a typo rather than the last-heading rule.
    const { view } = mountEditor('## Meeting notes\n\n- a line under the first heading\n', {
      on: false,
    });
    const text = noteLines(view.state.doc)
      .map((l) => view.state.doc.textBetween(l.from, l.to, ' '))
      .join(' | ');
    expect(text).toContain('a line under the first');
  });
});
