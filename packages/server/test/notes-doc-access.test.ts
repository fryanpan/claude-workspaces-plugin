/**
 * The three small modules the rebuilt note-taker stands on: the doc-store
 * slice it writes through, the parser that turns a model's reply into edits,
 * and the research placeholder that is now an ordinary block edit.
 *
 * WHY THEY ARE WORTH THEIR OWN FILE. Each replaced a private pathway — a
 * bespoke Yjs insert, a prose sanitizer, a section writer — and each is now
 * one call into the shared verbs. The value of that is only visible if the
 * verbs are asserted directly: exercising them through a whole meeting proves
 * the meeting works, not that a malformed reply is dropped with a reason.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  MEETING_NOTES_HEADING,
  NOTES_AUTHOR_ID,
  applyNotesBlockEdits,
  readNotesOutline,
} from '../src/notes-doc-access.ts';
import { parseNotesEdits } from '../src/notes-edit-parse.ts';
import {
  appendResearchPlaceholder,
  researchPlaceholderEdits,
} from '../src/notes-research-placeholder.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  if (markdown.length > 0) prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

const store = (docId: string, ydoc: Y.Doc, type: DocType = 'markdown') =>
  oneDocStore(docId, { ydoc, meta: { type } });

describe('applyNotesBlockEdits — the note-taker’s one write', () => {
  it('signs what it writes, so the next tick may revise its own words', () => {
    // The whole ownership model rests on this: a block written here carries
    // `meeting-notes`, and every "may I rewrite this" question downstream is
    // that field being read back.
    const ydoc = docFrom('# Huddle\n');
    const docStore = store('d', ydoc);
    const res = applyNotesBlockEdits(docStore, 'd', [
      { op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}\n\n- the gate moves` },
    ]);
    expect(res.ok).toBe(true);
    const blocks = readNotesOutline(docStore, 'd');
    expect(blocks.map((b) => b.author)).toEqual([undefined, NOTES_AUTHOR_ID, NOTES_AUTHOR_ID]);
    expect(markdownOf(ydoc)).toContain('- the gate moves');
  });

  it('an edit naming a block that is gone is refused, and the batch still lands', () => {
    const ydoc = docFrom('# Huddle\n');
    const docStore = store('d', ydoc);
    applyNotesBlockEdits(docStore, 'd', [{ op: 'insert_at_end', markdown: '- first' }]);
    const res = applyNotesBlockEdits(docStore, 'd', [
      { op: 'replace_block', blockId: 'no-such-block', markdown: '- ghost' },
      { op: 'insert_at_end', markdown: '- second' },
    ]);
    expect(res).toMatchObject({ ok: true, applied: 1 });
    const md = markdownOf(ydoc);
    expect(md).toContain('- first');
    expect(md).toContain('- second');
    expect(md).not.toContain('ghost');
  });
});

describe('readNotesOutline', () => {
  it('a doc that is gone reads as nothing to address, never as a throw', () => {
    // Both callers of this — the tick and the placeholder — run inside a live
    // meeting, where a doc that has been archived mid-session must cost the
    // tick its notes and nothing else.
    const docStore = store('d', docFrom('# Huddle\n'));
    expect(readNotesOutline(docStore, 'gone')).toEqual([]);
  });

  it('headingsOnly is the question the placeholder asks, and it drops the bullets', () => {
    const docStore = store('d', docFrom('# Huddle\n\n- a bullet\n\n## Risks\n\n- another\n'));
    expect(readNotesOutline(docStore, 'd', { headingsOnly: true }).map((e) => e.text)).toEqual([
      'Huddle',
      'Risks',
    ]);
    expect(readNotesOutline(docStore, 'd').length).toBeGreaterThan(2);
  });
});

describe('parseNotesEdits', () => {
  it('reads a bare array, and an object with an edits array', () => {
    const one = '{"op":"insert_at_end","markdown":"- a point"}';
    expect(parseNotesEdits(`[${one}]`).edits).toEqual([
      { op: 'insert_at_end', markdown: '- a point' },
    ]);
    expect(parseNotesEdits(`{"edits":[${one}]}`).edits).toHaveLength(1);
  });

  it('unwraps a fence and steps over a sentence of preamble', () => {
    const body = '[{"op":"insert_at_end","markdown":"- a point"}]';
    expect(parseNotesEdits('```json\n' + body + '\n```').edits).toHaveLength(1);
    expect(parseNotesEdits(`Here are the edits:\n${body}`).edits).toHaveLength(1);
  });

  it('keeps the good entries and says what it dropped, and why', () => {
    const parsed = parseNotesEdits(
      JSON.stringify([
        { op: 'insert_at_end', markdown: '- keep me' },
        { op: 'teleport', blockId: 'b1' },
        { op: 'replace_block', markdown: '- no id' },
        { op: 'delete_block', blockId: 'b2' },
      ]),
    );
    expect(parsed.edits).toEqual([
      { op: 'insert_at_end', markdown: '- keep me' },
      { op: 'delete_block', blockId: 'b2' },
    ]);
    expect(parsed.dropped).toHaveLength(2);
    expect(parsed.dropped[0]).toContain('unknown op');
    expect(parsed.dropped[1]).toContain('replace_block without id');
  });

  it('prose is not an edit list, and says so instead of becoming the notes', () => {
    // The failure this parser exists for. Under the old contract this string
    // WAS the answer — anything the model said became the notes — so a model
    // that ignored the format silently wrote a section.
    const parsed = parseNotesEdits('## Meeting notes\n\n- the sync is slow');
    expect(parsed.edits).toEqual([]);
    expect(parsed.dropped).toEqual(['reply was not JSON']);
  });

  it('a JSON value that is not a list of edits is one dropped line, not a crash', () => {
    expect(parseNotesEdits('{"notes":"- a point"}').dropped).toEqual([
      'reply held no array of edits',
    ]);
    expect(parseNotesEdits('[').dropped).toEqual(['reply was not JSON']);
    expect(parseNotesEdits('').dropped).toEqual(['reply was not JSON']);
  });

  it('keeps a nested bullet’s indentation while trimming the trailing space', () => {
    // Leading space is structure — eat it and a sub-point flattens into the
    // list above it.
    const parsed = parseNotesEdits(
      JSON.stringify([{ op: 'insert_at_end', markdown: '  - nested   \n' }]),
    );
    expect(parsed.edits[0]).toEqual({ op: 'insert_at_end', markdown: '  - nested' });
  });
});

describe('the research placeholder', () => {
  it('writes a section naming the row, and links it', () => {
    const ydoc = docFrom('# Huddle\n');
    const docStore = store('d', ydoc);
    expect(appendResearchPlaceholder(docStore, 'd', 'Offline queue', '/w/t-9')).toEqual({
      ok: true,
      mode: 'appended',
    });
    const md = markdownOf(ydoc);
    expect(md).toContain('## Offline queue');
    expect(md).toContain('[Offline queue](/w/t-9)');
  });

  it('is idempotent by heading — the same ask twice leaves one section', () => {
    const ydoc = docFrom('# Huddle\n');
    const docStore = store('d', ydoc);
    appendResearchPlaceholder(docStore, 'd', 'Offline queue', '/w/t-9');
    expect(appendResearchPlaceholder(docStore, 'd', 'Offline queue', '/w/t-9')).toEqual({
      ok: true,
      mode: 'present',
    });
    expect(markdownOf(ydoc).split('## Offline queue').length).toBe(2);
  });

  it('the block it writes is the note-taker’s, like every other note', () => {
    // It used to be a bespoke Yjs insert with its own placement rule, which
    // left a block nobody owned. Now a later edit of it obeys the same
    // ownership rule as a bullet, and this is what says so.
    const ydoc = docFrom('# Huddle\n');
    const docStore = store('d', ydoc);
    appendResearchPlaceholder(docStore, 'd', 'Offline queue', '/w/t-9');
    const heading = readNotesOutline(docStore, 'd').find((e) => e.text === 'Offline queue');
    expect(heading?.author).toBe(NOTES_AUTHOR_ID);
  });

  it('a doc that is gone and a doc that is not prose are both refusals, not throws', () => {
    const docStore = store('d', docFrom('# Huddle\n'));
    expect(appendResearchPlaceholder(docStore, 'gone', 'X', '/w/t-1')).toEqual({
      ok: false,
      error: 'not-found',
    });
    const flat = store('f', docFrom('# Huddle\n'), 'diff');
    expect(appendResearchPlaceholder(flat, 'f', 'X', '/w/t-1').ok).toBe(false);
  });

  it('decides on an outline alone, so a caller holding one reads no second time', () => {
    const outline: prose.OutlineEntry[] = [
      { id: 'h1', kind: 'heading', nodeName: 'heading', level: 2, text: 'Offline queue' },
    ];
    expect(researchPlaceholderEdits(outline, 'Offline queue', '/w/t-9')).toEqual([]);
    expect(researchPlaceholderEdits(outline, 'Export range', '/w/t-9')).toHaveLength(1);
    // A titleless ask writes nothing rather than a heading reading "##".
    expect(researchPlaceholderEdits([], '   ', '/w/t-9')).toEqual([]);
  });
});
