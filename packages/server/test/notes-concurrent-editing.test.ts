/**
 * A person editing the doc WHILE the meeting writes into it.
 *
 * This is the case the rebuild exists for. The old note-taker found its
 * section by heading text and replaced it wholesale, so a person renaming the
 * heading gave it a second section, formatting inside the section was thrown
 * away on the next tick, and a block the editor re-created (which the browser
 * does on paste, on undo, and on some list operations) came back as a
 * duplicate bullet. Every one of those is a statement about a SEQUENCE of
 * ticks crossed by a person's edits, so they are all driven through the tick
 * harness against a real `Y.Doc`.
 *
 * A person's edit is a NON-STRING transaction origin — that is what
 * `prose.isPersonOrigin` reads, and what makes the doc clear the
 * note-taker's authorship off the block they touched. A string origin is a
 * server write. `asPerson` is that distinction spelled once; a test that used
 * a string here would assert "their line was not rewritten" for a reason that
 * has nothing to do with the person.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import { MEETING_NOTES_HEADING, type NotesDocStore } from '../src/notes-doc-access.ts';
import { allBullets } from '../src/notes-quality.ts';
import { asPerson, headingsOf, oneDocStore } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** Every top-level element of the doc, which is the level a list lives at. */
const topLevel = (ydoc: Y.Doc): Y.XmlElement[] =>
  prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];

/** The h2s in the doc. The meeting's section is one of these, whatever it is
 *  currently called, so this is how "did a second section appear" is asked
 *  once the heading has been renamed. */
const sectionHeadings = (ydoc: Y.Doc): string[] =>
  topLevel(ydoc)
    .filter((el) => el.nodeName === 'heading' && prose.headingLevelOf(el) === 2)
    .map((el) =>
      prose
        .serializeBlockToMarkdown(el)
        .replace(/^#{1,6}\s+/, '')
        .trim(),
    );

/** The whole doc as markdown — what serializes to disk and what a reader sees. */
const markdownOf = (ydoc: Y.Doc): string =>
  prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

/** The first text node inside a block, which is where marks live. */
function textNodeOf(el: Y.XmlElement): Y.XmlText {
  const kids = el.toArray();
  for (const kid of kids) {
    if (kid instanceof Y.XmlText) return kid;
    if (kid instanceof Y.XmlElement) {
      const found = textNodeOf(kid);
      if (found) return found;
    }
  }
  throw new Error(`no text node under ${el.nodeName}`);
}

/** Find the top-level list item whose text contains `needle`. */
function findItem(ydoc: Y.Doc, needle: string): Y.XmlElement {
  for (const el of prose.addressableBlocks(prose.getProseFragment(ydoc))) {
    if (prose.serializeBlockToMarkdown(el).includes(needle)) return el;
  }
  throw new Error(`no block reading ${needle}`);
}

describe('a person editing the notes while the meeting writes them', () => {
  it('renames the heading, formats a note and re-creates a block — and nothing doubles', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- The sync wakes every ninety seconds.')
          : addNotes(input, `- Point ${tick}.`),
    });

    await harness.speak('The sync wakes every ninety seconds.');
    const ydoc = harness.ydoc;

    // (1) THE RENAME. The heading the meeting opened is now called something
    // else. Under the old note-taker this was the whole bug: the next tick
    // looked for "Meeting notes", found none, and opened a second section.
    asPerson(ydoc, () => {
      const heading = topLevel(ydoc).find(
        (el) => el.nodeName === 'heading' && prose.headingLevelOf(el) === 2,
      );
      if (!heading) throw new Error('the meeting opened no section');
      const text = textNodeOf(heading);
      text.delete(0, text.length);
      text.insert(0, 'Tuesday sync');
    });

    await harness.speak('And the retry loop never backs off.');

    // (2) THE FORMATTING. A person bolds part of a bullet the note-taker
    // wrote. A whole-section replace ate marks like this every tick.
    asPerson(ydoc, () => {
      const bullet = findItem(ydoc, 'ninety seconds');
      const text = textNodeOf(bullet);
      text.format(0, 8, { bold: true });
    });

    // (3) THE RE-CREATION. The editor rebuilds a block rather than mutating
    // it — what a paste, an undo or a list-indent does. The new node carries a
    // new identity, so anything that remembered the old id is now holding a
    // reference to a block that no longer exists.
    const theirLine = 'I think this predates the 0.4 rollout';
    asPerson(ydoc, () => {
      const fragment = prose.getProseFragment(ydoc);
      fragment.insert(fragment.length, prose.parseMarkdownBlocks(`- ${theirLine}`));
    });
    asPerson(ydoc, () => {
      // Delete and re-insert the bullet they just typed, with the same words:
      // the editor's own round trip through a paste.
      const fragment = prose.getProseFragment(ydoc);
      const at = topLevel(ydoc).findIndex((el) =>
        prose.serializeBlockToMarkdown(el).includes(theirLine),
      );
      fragment.delete(at, 1);
      fragment.insert(at, prose.parseMarkdownBlocks(`- ${theirLine}`));
    });

    await harness.speak('One more thing about the queue.');
    await harness.end();

    const md = markdownOf(ydoc);

    // ONE section, still, under whatever it is now called. The meeting
    // remembers the block ID it opened, so a rename is a non-event.
    expect(sectionHeadings(ydoc)).toEqual(['Tuesday sync']);
    expect(harness.countHeadings(MEETING_NOTES_HEADING)).toBe(0);

    // NO LINE TWICE — neither the agent's nor the person's.
    const bullets = allBullets(md);
    for (const line of new Set(bullets)) {
      expect(bullets.filter((b) => b === line)).toHaveLength(1);
    }
    expect(bullets.filter((b) => b.includes('ninety seconds'))).toHaveLength(1);
    expect(bullets.filter((b) => b.includes('predates'))).toHaveLength(1);

    // BOTH SIDES' FORMATTING SURVIVED: the person's bold is still on the
    // agent's bullet, and the agent's later notes are all still there.
    expect(md).toContain('**The sync**');
    expect(md).toContain('- Point 2.');
    expect(md).toContain('- Point 3.');

    // AND THEIR OWN WORDS WERE NEVER REWRITTEN.
    expect(md).toContain(theirLine);
    expect(harness.errors).toEqual([]);
  });

  it('a person deleting the whole section does not make the meeting write into theirs', async () => {
    // The other half of remembering a block id: the id is GONE, so the next
    // tick opens a section rather than adopting whatever heading is nearest —
    // which, in a doc a person is writing in, would be a heading of theirs.
    const harness = createNotesTickHarness({
      doc: '# Huddle\n\n## My own agenda\n\n- a line I typed\n',
      compose: (input, tick) => addNotes(input, `- Point ${tick}.`),
    });
    await harness.speak('The sync wakes every ninety seconds.');
    const ydoc = harness.ydoc;

    asPerson(ydoc, () => {
      const fragment = prose.getProseFragment(ydoc);
      const at = topLevel(ydoc).findIndex(
        (el) =>
          el.nodeName === 'heading' &&
          prose.serializeBlockToMarkdown(el).includes(MEETING_NOTES_HEADING),
      );
      // The heading and everything after it — the section, as a person would
      // select and delete it.
      fragment.delete(at, topLevel(ydoc).length - at);
    });

    await harness.speak('And the retry loop never backs off.');
    await harness.end();

    const md = markdownOf(ydoc);
    // Their agenda is untouched and their line is not under a meeting heading.
    expect(md).toContain('## My own agenda');
    expect(md).toContain('- a line I typed');
    expect(headingsOf(ydoc).filter((h) => h === MEETING_NOTES_HEADING)).toHaveLength(1);
    expect(md).toContain('- Point 2.');
    expect(harness.errors).toEqual([]);
  });
});

describe('the shape of the doc after any tick', () => {
  it('never leaves two adjacent lists of the same kind', async () => {
    // A list that lands beside a list of its own type is a bug a reader SEES:
    // the second one restarts numbering, and the gap between them is not a
    // paragraph break. It cannot be asserted from one write — it is a
    // statement about every state a sequence of ticks passes through — so the
    // check runs after each one.
    const adjacentSameType = (ydoc: Y.Doc): string[] => {
      const bad: string[] = [];
      const top = topLevel(ydoc);
      for (let i = 1; i < top.length; i++) {
        const a = top[i - 1]!.nodeName;
        const b = top[i]!.nodeName;
        if (a === b && (a === 'bulletList' || a === 'orderedList')) bad.push(`${i - 1}/${i}: ${a}`);
      }
      return bad;
    };

    const script = [
      '- The sync wakes every ninety seconds.',
      '- The backoff never resets.',
      '### Export range\n\n- The dialog forgets the range.',
      '1. Measure first.\n2. Then cap the retry.',
      '- One more for the queue.',
      '1. And a second numbered list.',
    ];
    const harness = createNotesTickHarness({
      doc: '# Huddle\n\n- an agenda bullet a person typed\n',
      compose: (input, tick) => addNotes(input, script[tick - 1] ?? '- trailing.'),
    });

    for (let i = 0; i < script.length; i++) {
      await harness.speak(`Utterance ${i}.`);
      expect(adjacentSameType(harness.ydoc)).toEqual([]);
    }
    await harness.end();
    expect(adjacentSameType(harness.ydoc)).toEqual([]);
    // The control: the ticks really did write lists of both kinds, so the
    // check above had something to find.
    const names = topLevel(harness.ydoc).map((el) => el.nodeName);
    expect(names).toContain('bulletList');
    expect(names).toContain('orderedList');
    expect(harness.errors).toEqual([]);
  });
});

describe('applyBlockEdits is the write', () => {
  /**
   * The store, wrapped so the test can see and refuse the one verb.
   *
   * `withServerNotesSinks` builds its own store from the server, so this
   * drives `applyNotesUpdate` — the function that sink calls — directly. That
   * is the whole of the tick's write path: everything between a composer's
   * reply and the doc is in there.
   */
  const watched = (
    inner: NotesDocStore,
    opts: { refuse?: boolean } = {},
  ): { store: NotesDocStore; calls: number } => {
    const state = { calls: 0 };
    const store: NotesDocStore = {
      ...inner,
      get: (docId) => inner.get(docId),
      readOutline: (docId, o) => inner.readOutline(docId, o),
      applyBlockEdits: (docId, edits, who) => {
        state.calls++;
        return opts.refuse
          ? { ok: false, error: 'not-found' }
          : inner.applyBlockEdits(docId, edits, who);
      },
    };
    return {
      store,
      get calls() {
        return state.calls;
      },
    };
  };

  const update = (docId: string, markdown: string): NotesUpdate => ({
    docId,
    meetingId: `m-${docId}`,
    tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'hi' }] },
    edits: [{ op: 'insert_at_end', markdown }],
  });

  const doc = (): Y.Doc => {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), '# Huddle\n');
    return ydoc;
  };

  it('a tick’s notes reach the doc through it, and through nothing else', () => {
    const ydoc = doc();
    const watcher = watched(oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } }));
    expect(
      applyNotesUpdate(watcher.store, update('d', '- a note'), createNotesHeadingMemory()),
    ).toBe(true);
    expect(watcher.calls).toBe(1);
    expect(markdownOf(ydoc)).toContain('- a note');
  });

  it('refusing it leaves the doc untouched — there is no second pathway', () => {
    // The control that makes the count above mean something. If any part of
    // the notes path still wrote a Yjs fragment of its own, the words would
    // arrive despite the refusal.
    const ydoc = doc();
    const before = markdownOf(ydoc);
    const watcher = watched(oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } }), {
      refuse: true,
    });
    expect(
      applyNotesUpdate(watcher.store, update('d', '- a note'), createNotesHeadingMemory()),
    ).toBe(false);
    expect(watcher.calls).toBe(1);
    expect(markdownOf(ydoc)).toBe(before);
    expect(markdownOf(ydoc)).not.toContain('a note');
  });
});
