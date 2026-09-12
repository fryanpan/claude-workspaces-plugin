/**
 * WHAT THE CLEANUP PASS LEAVES BEHIND IN THE SECTION, asked of the document
 * rather than of the pass's own counters.
 *
 * Bryan's 2026-09-11 doc had two empty paragraphs directly under its
 * `## Meeting notes` heading and `### Note-taker performance` twice in a row,
 * each with bullets under it. Both had survived a cleanup pass, because
 * neither is something the pass can propose its way out of: a delete naming
 * an unmarked blank line comes back as a redline ON the blank line, and a
 * model cannot reliably avoid opening a topic it opened in a tick it can no
 * longer see.
 *
 * Every fixture drives the real pass over a real Y.Doc. All notes and all
 * speech are invented and every name is fictional. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import {
  DOC,
  MEETING,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

/** The doc as a reader sees it. */
const markdownOf = (ydoc: Y.Doc): string =>
  prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

/** Every top-level heading in the doc, in order, `#` marks stripped. */
const headings = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'heading')
    .map((e) => e.text);

/** Every bullet in the doc, in order. */
const bullets = (ydoc: Y.Doc): string[] =>
  prose
    .readOutline(ydoc)
    .filter((e) => e.kind === 'listItem')
    .map((e) => e.text);

/**
 * An EMPTY PARAGRAPH, inserted straight after the block holding `after`.
 *
 * Written into the document rather than into the markdown because markdown
 * cannot say it: a blank line parses to nothing at all, which is exactly why
 * one in a live doc has no author and no words to argue with.
 */
function blankAfter(ydoc: Y.Doc, after: string): void {
  const top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
  const at = top.findIndex((el) => prose.serializeBlockToMarkdown(el).includes(after));
  expect(at).toBeGreaterThanOrEqual(0);
  prose.getProseFragment(ydoc).insert(at + 1, [new Y.XmlElement('paragraph')]);
}

/** Run a real cleanup pass whose model proposes nothing. */
async function cleanup(store: NotesDocStore, headingId: string) {
  const dataDir = freshDir();
  writeTranscript(dataDir, [{ turn: 0, text: 'the harbour run moves to the half hour' }]);
  return runNotesCleanupPass(depsFor(store, stubComposer([]), dataDir, headingId), {
    docId: DOC,
    meetingId: MEETING,
  });
}

const NOTES_WITH_BLANKS = [
  '# Riverbend ferry review',
  '',
  '## Meeting notes',
  '',
  '### Ferry timetable',
  '',
  '- The harbour run moves to the half hour from April',
].join('\n');

describe('empty paragraphs under a Meeting notes heading', () => {
  it('are gone after the cleanup pass, and nothing with words in it is', async () => {
    const { store, ydoc } = docStoreFrom(NOTES_WITH_BLANKS, ['## Meeting notes']);
    blankAfter(ydoc, '## Meeting notes');
    blankAfter(ydoc, '## Meeting notes');
    const headingId = idOf(store, 'Meeting notes');
    // The shape the doc is actually in before the pass — without this the
    // case could pass over a document that never had a blank in it.
    expect(prose.readOutline(ydoc).filter((e) => e.text.length === 0)).toHaveLength(2);

    const result = await cleanup(store, headingId);
    expect(result.ok).toBe(true);
    expect(result.blanks).toBe(2);
    expect(prose.readOutline(ydoc).filter((e) => e.text.length === 0)).toHaveLength(0);
    // And the notes themselves are untouched.
    expect(bullets(ydoc)).toEqual(['The harbour run moves to the half hour from April']);
    expect(headings(ydoc)).toEqual(['Riverbend ferry review', 'Meeting notes', 'Ferry timetable']);
  });

  it('CONTROL: a blank line OUTSIDE the section is left where it is', async () => {
    const { store, ydoc } = docStoreFrom(NOTES_WITH_BLANKS, ['## Meeting notes']);
    blankAfter(ydoc, '# Riverbend ferry review');
    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.blanks).toBe(0);
    expect(prose.readOutline(ydoc).filter((e) => e.text.length === 0)).toHaveLength(1);
  });

  it('CONTROL: a line that only LOOKS blank keeps its words', async () => {
    // `&nbsp;` is a character somebody typed. The rule is "serializes to
    // nothing", not "looks empty on screen".
    const doc = NOTES_WITH_BLANKS.replace('### Ferry timetable', '&nbsp;\n\n### Ferry timetable');
    const { store, ydoc } = docStoreFrom(doc, ['## Meeting notes']);
    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.blanks).toBe(0);
    expect(markdownOf(ydoc)).toContain('&nbsp;');
  });
});

const NOTES_WITH_TWIN = [
  '# Riverbend ferry review',
  '',
  '## Meeting notes',
  '',
  '### Note-taker performance',
  '',
  '- The notes landed about six seconds behind the room',
  '',
  '### Note-taker performance',
  '',
  '- Two of them repeated a point from the first half',
].join('\n');

describe('the same topic heading twice under one Meeting notes section', () => {
  it('is one heading after the pass, and every bullet is still there', async () => {
    const { store, ydoc } = docStoreFrom(NOTES_WITH_TWIN, ['## Meeting notes']);
    expect(headings(ydoc).filter((h) => h === 'Note-taker performance')).toHaveLength(2);

    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.merged).toBe(1);
    expect(headings(ydoc).filter((h) => h === 'Note-taker performance')).toHaveLength(1);
    expect(bullets(ydoc)).toEqual([
      'The notes landed about six seconds behind the room',
      'Two of them repeated a point from the first half',
    ]);
  });

  it('reads the topic the way a reader does, not the way a string compare does', async () => {
    const doc = NOTES_WITH_TWIN.replace(
      '### Note-taker performance\n\n- Two of them',
      '### Note-taker Performance:\n\n- Two of them',
    );
    const { store, ydoc } = docStoreFrom(doc, ['## Meeting notes']);
    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.merged).toBe(1);
    expect(headings(ydoc).filter((h) => h.startsWith('Note-taker'))).toHaveLength(1);
    expect(bullets(ydoc)).toHaveLength(2);
  });

  it('CONTROL: two different topics both stay', async () => {
    const doc = NOTES_WITH_TWIN.replace(
      '### Note-taker performance\n\n- Two of them',
      '### Meeting page on the phone\n\n- Two of them',
    );
    const { store, ydoc } = docStoreFrom(doc, ['## Meeting notes']);
    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.merged).toBe(0);
    expect(headings(ydoc)).toHaveLength(4);
  });

  it('CONTROL: a repeat with another topic between them is left alone', async () => {
    // Dropping this one would hand its bullets to the topic in between,
    // which files them under the wrong subject. Merging it means moving
    // bullets, which re-creates them and takes their comment anchors along.
    const doc = [
      NOTES_WITH_TWIN.split('### Note-taker performance\n\n- Two of them')[0],
      '### Meeting page on the phone',
      '',
      '- The recording button is below the fold',
      '',
      '### Note-taker performance',
      '',
      '- Two of them repeated a point from the first half',
    ].join('\n');
    const { store, ydoc } = docStoreFrom(doc, ['## Meeting notes']);
    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.merged).toBe(0);
    expect(headings(ydoc).filter((h) => h === 'Note-taker performance')).toHaveLength(2);
    expect(bullets(ydoc)).toHaveLength(3);
  });

  it('CONTROL: a repeat somebody has commented on keeps its heading', async () => {
    const { store, ydoc } = docStoreFrom(NOTES_WITH_TWIN, ['## Meeting notes']);
    // A thread anchored in the SECOND heading, the way the editor writes one.
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
    const needle = 'Note-taker performance';
    const at = walk.plainText.lastIndexOf(needle);
    const seg = walk.segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
    if (!seg) throw new Error('the heading has no text segment');
    const thread = new Y.Map<unknown>();
    thread.set('anchor', {
      kind: 'text-range',
      startRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset),
      ),
      endRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset + needle.length),
      ),
      snippet: { text: needle },
    });
    (ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).set('t1', thread);

    const result = await cleanup(store, idOf(store, 'Meeting notes'));
    expect(result.merged).toBe(0);
    expect(headings(ydoc).filter((h) => h === 'Note-taker performance')).toHaveLength(2);
  });
});
