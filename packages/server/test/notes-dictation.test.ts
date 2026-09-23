/**
 * A speaker dictating a document's shape gets that shape: one heading per
 * page in the speaker's words, and each item one numbered note in the order
 * given.
 *
 * Three layers, each driven directly: which sentences are layout cues, what
 * the per-tick directive asks for, and the fold that keeps a spoken detail
 * inside the numbered list. Then the whole chain through a real notes doc,
 * because the list only survives if every stage agrees.
 *
 * All speech and notes are invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import {
  DICTATION_WINDOW,
  type DictationTick,
  createDictationMemory,
  dictationCues,
  dictationDirective,
  dictationTickOf,
  foldDetailsIntoItem,
  pageNumber,
  pageOfHeading,
} from '../src/notes-dictation.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { input } from './notes-compose-input.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const said = (...texts: string[]): Array<{ text: string }> => texts.map((text) => ({ text }));

/** The tick `last` makes after each of `before`, one tick each, through a session's memory. */
function tickAfter(before: readonly string[], last: string): DictationTick {
  const memory = createDictationMemory();
  for (const text of before) memory.see(said(text));
  return memory.see(said(last));
}
/** `text` spoken while a dictation is running: a page was just opened. */
const dictating = (text: string): DictationTick => tickAfter(['Page one is the repairs.'], text);

function entry(
  id: string,
  text: string,
  over: Partial<prose.OutlineEntry> = {},
): prose.OutlineEntry {
  return {
    id,
    kind: 'listItem',
    nodeName: 'listItem',
    text,
    depth: 0,
    author: NOTES_AUTHOR_ID,
    ...over,
  };
}
const page = (id: string, text: string): prose.OutlineEntry =>
  entry(id, text, { kind: 'heading', nodeName: 'heading', level: 2, depth: undefined });
const item = (id: string, text: string, under: string): prose.OutlineEntry =>
  entry(id, text, { underHeadingId: under, ordered: true });

describe('page numbers', () => {
  it('reads a page number the same written as a word or as digits', () => {
    expect(pageNumber('two')).toBe('2');
    expect(pageNumber('2')).toBe('2');
    expect(pageOfHeading('Page one: Riverbend street repairs')).toBe('1');
    expect(pageOfHeading('Page 1')).toBe('1');
    expect(pageOfHeading('Riverbend street repairs')).toBeUndefined();
  });
});

describe('dictationCues', () => {
  it('finds the page, the count and each ordered item', () => {
    const cues = dictationCues(
      said(
        'It has two pages.',
        'Page two is the Saltmarsh flooding.',
        'Start with the map of the drains.',
        'Then the complaints by month.',
        'The last thing on page two is the ask.',
      ),
    );
    expect(cues.map((c) => [c.kind, c.page])).toEqual([
      ['count', undefined],
      ['page', '2'],
      ['item', undefined],
      ['item', undefined],
      ['item', '2'],
    ]);
  });

  it('finds nothing in ordinary talk', () => {
    expect(dictationCues(said('The drains overflow at every spring tide.'))).toEqual([]);
  });

  it('opens no page when a page is only mentioned in conversation', () => {
    expect(
      dictationCues(
        said('Page 2 is broken.', 'Section 3 is wrong.', 'Page two is loading slowly.'),
      ),
    ).toEqual([]);
    expect(dictationCues(said('The fix is on page two of the report.'))).toEqual([]);
  });
});

describe('createDictationMemory', () => {
  it('counts an ordering word as an item only while a dictation is running', () => {
    expect(dictating('Then the cost per block.').cues.map((c) => c.kind)).toEqual(['item']);
    expect(tickAfter([], 'Then the cost per block.').cues).toEqual([]);
    expect(tickAfter(['Page 2 is broken.'], 'Then we fix the login.').cues).toEqual([]);
  });

  it('keeps a dictation open across a detail, and closes it once the talk moves on', () => {
    const detail = 'We repave the high street first.';
    const open = tickAfter(['Page one is the repairs.', detail], 'Then the cost per block.');
    expect(open.cues.map((c) => c.kind)).toEqual(['item']);
    expect(open.sinceCue).toBe(2);
    const lapsed = tickAfter(
      ['Page one is the repairs.', ...Array(DICTATION_WINDOW).fill(detail)],
      'Then we move on to the budget.',
    );
    expect(lapsed.cues).toEqual([]);
    expect(lapsed.sinceCue).toBeUndefined();
  });
});

describe('dictationDirective', () => {
  it('stays silent in a meeting nobody dictated, even when someone says "then"', () => {
    const outline = [page('h1', 'Riverbend repairs'), entry('b1', 'crews start in June')];
    expect(dictationDirective(outline, tickAfter([], 'Then we move on to the budget.'))).toBeNull();
  });

  it('emits nothing on a tick with no cue, even with a page heading last in the doc', () => {
    const outline = [page('h1', 'Page one: repairs'), item('b1', 'Cost per block', 'h1')];
    expect(dictationDirective(outline, dictating('We repave the high street first.'))).toBeNull();
    expect(dictationDirective(outline, tickAfter([], 'The crews start in June.'))).toBeNull();
  });

  it('opens no page for a page mentioned in ordinary talk', () => {
    expect(dictationDirective([], tickAfter([], 'Page 2 is broken on the phone.'))).toBeNull();
  });

  it('names the page heading, the next number and the edit for an item', () => {
    const outline = [
      page('h1', 'Page one: Riverbend street repairs'),
      item('b1', 'List of streets to repave', 'h1'),
    ];
    const out =
      dictationDirective(outline, dictating('Then the cost per block for each street.')) ?? '';
    expect(out).toContain(
      '{"op":"insert_under_heading","headingId":"h1","markdown":"2. <the item>"}',
    );
  });

  it("asks for a new page to open with the speaker's words for it", () => {
    const out =
      dictationDirective([], dictationTickOf(said('Page two is the Saltmarsh flooding.'))) ?? '';
    expect(out).toContain('"Page 2: <what the page is>"');
  });

  it('asks for a bare page heading to be named rather than opened twice', () => {
    const out =
      dictationDirective(
        [page('h1', 'Page 1')],
        dictationTickOf(said('Page one is the repairs.')),
      ) ?? '';
    expect(out).toContain('{"op":"replace_block","blockId":"h1","markdown":"## Page 1: <what');
  });

  it('sends items to the page the speaker is on when both pages were opened at once', () => {
    const early = [page('h1', 'Page one: Riverbend repairs'), page('h2', 'Page 2')];
    expect(dictationDirective(early, dictating('Then the cost per block.'))).toContain(
      '"headingId":"h1"',
    );
    const later = [page('h1', 'Page one: Riverbend repairs'), page('h2', 'Page 2: Saltmarsh')];
    expect(dictationDirective(later, dictating('Then the complaints.'))).toContain(
      '"headingId":"h2"',
    );
    const bare = [page('h1', 'Page 1'), page('h2', 'Page 2')];
    expect(dictationDirective(bare, dictating('Start with the map.'))).toContain(
      '"headingId":"h1"',
    );
  });

  it('rides in the tick prompt only when the tick dictates', () => {
    const dictated = {
      ...input,
      tick: { ...input.tick, turns: [{ turn: 1, text: 'Page two is the flooding.' }] },
    };
    expect(buildNotesPrompt(dictated).user).toContain('THIS SPEECH DICTATES');
    expect(buildNotesPrompt(input).user).not.toContain('THIS SPEECH DICTATES');
  });
});

describe('foldDetailsIntoItem', () => {
  const outline = [page('h1', 'Page one: repairs'), item('b1', 'Cost per block', 'h1')];
  const dash = (markdown: string): prose.BlockEdit => ({
    op: 'insert_under_heading',
    headingId: 'h1',
    markdown,
  });
  /** A detail spoken on the tick straight after an item was placed. */
  const detail = tickAfter(
    ['Page one is the repairs.', 'Start with the cost per block.'],
    'We repave the high street before the harbour road.',
  );

  it('turns a dash note after the last item into a sub-bullet of it', () => {
    const out = foldDetailsIntoItem(
      [dash('- High street before harbour road')],
      outline,
      detail,
      NOTES_AUTHOR_ID,
    );
    expect(out.folded).toBe(1);
    expect(out.edits).toEqual([
      {
        op: 'replace_block',
        blockId: 'b1',
        markdown: '1. Cost per block\n   - High street before harbour road',
      },
    ]);
  });

  it('leaves a question or a labelled note where the model put it', () => {
    const edits = [dash('- **Question:** who holds the gate key?')];
    expect(foldDetailsIntoItem(edits, outline, detail, NOTES_AUTHOR_ID).folded).toBe(0);
  });

  it('leaves the batch alone when the tick names the next item', () => {
    const edits = [dash('- Crew schedule')];
    const next = dictating('Then the crew schedule.');
    expect(foldDetailsIntoItem(edits, outline, next, NOTES_AUTHOR_ID).folded).toBe(0);
  });

  it('folds only on the tick straight after a cue, not every later dash note', () => {
    const edits = [dash('- Budget review next week')];
    const later = tickAfter(
      ['Page one is the repairs.', 'Start with the cost per block.', 'We repave the high street.'],
      'The budget review is next week.',
    );
    expect(later.sinceCue).toBe(2);
    expect(foldDetailsIntoItem(edits, outline, later, NOTES_AUTHOR_ID).folded).toBe(0);
    expect(foldDetailsIntoItem(edits, outline, undefined, NOTES_AUTHOR_ID).folded).toBe(0);
  });

  it("keeps the item's own marks when the doc can say what they are", () => {
    const out = foldDetailsIntoItem(
      [dash('- High street first')],
      outline,
      detail,
      NOTES_AUTHOR_ID,
      (id) =>
        id === 'b1' ? 'Cost per **block**, see [the table](https://example.com/t)' : undefined,
    );
    expect(out.edits).toEqual([
      {
        op: 'replace_block',
        blockId: 'b1',
        markdown:
          '1. Cost per **block**, see [the table](https://example.com/t)\n   - High street first',
      },
    ]);
  });

  it('leaves an item somebody else wrote, or one the outline cut short', () => {
    const edits = [dash('- High street first')];
    const theirs = [
      outline[0] as prose.OutlineEntry,
      { ...outline[1], author: undefined } as prose.OutlineEntry,
    ];
    const cut = [
      outline[0] as prose.OutlineEntry,
      { ...outline[1], text: 'Cost per blo…' } as prose.OutlineEntry,
    ];
    expect(foldDetailsIntoItem(edits, theirs, detail, NOTES_AUTHOR_ID).folded).toBe(0);
    expect(foldDetailsIntoItem(edits, cut, detail, NOTES_AUTHOR_ID).folded).toBe(0);
  });

  it('folds under the page the speaker is on, ahead of a page opened early', () => {
    const early = [...outline, page('h2', 'Page 2')];
    const edits = [dash('- High street first')];
    expect(foldDetailsIntoItem(edits, early, detail, NOTES_AUTHOR_ID).folded).toBe(1);
    const atEnd: prose.BlockEdit[] = [{ op: 'insert_at_end', markdown: '- High street first' }];
    expect(foldDetailsIntoItem(atEnd, early, detail, NOTES_AUTHOR_ID).folded).toBe(0);
  });

  it('leaves a heading that is not a dictated page alone', () => {
    const topical = [page('h1', 'Riverbend repairs'), item('b1', 'Cost per block', 'h1')];
    const edits = [dash('- High street first')];
    expect(foldDetailsIntoItem(edits, topical, detail, NOTES_AUTHOR_ID).folded).toBe(0);
  });
});

describe('a dictated page through a notes doc', () => {
  it('names the bare page, keeps a detail inside the list, and numbers every item', async () => {
    let step = 0;
    const h = createNotesTickHarness({
      docId: 'd-dictation',
      meetingId: 'm-dictation',
      docTitle: 'Harborlight council update',
      compose: async (tick) => {
        step++;
        const head = tick.outline.find((e) => e.kind === 'heading');
        if (step === 1) return [{ op: 'insert_at_end', markdown: '## Page one' }];
        if (!head) return [];
        if (step === 2) {
          return [
            { op: 'replace_block', blockId: head.id, markdown: '## Page one: Riverbend repairs' },
            { op: 'insert_under_heading', headingId: head.id, markdown: '1. List of **streets**' },
          ];
        }
        if (step === 3) {
          return [
            { op: 'insert_under_heading', headingId: head.id, markdown: '- High street first' },
          ];
        }
        return [{ op: 'insert_under_heading', headingId: head.id, markdown: '2. Crew schedule' }];
      },
    });
    await h.speak({ speaker: 'A', text: 'It has two pages.' });
    await h.speak({
      speaker: 'A',
      text: 'Page one is the Riverbend repairs. Start with the list of streets.',
    });
    await h.speak({ speaker: 'A', text: 'We repave the high street before the harbour road.' });
    await h.speak({ speaker: 'A', text: 'The last thing is the crew schedule.' });
    expect(
      h
        .markdown()
        .split('\n')
        .filter((l) => l.trim()),
    ).toEqual([
      '## Page one: Riverbend repairs',
      '1. List of **streets**',
      '   - High street first',
      '2. Crew schedule',
    ]);
  });
});
