import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  BACKUP_SUFFIX,
  findGapSites,
  repairDataDir,
  repairNoteListGaps,
} from '../src/note-list-gap-repair.ts';

/**
 * The repair for documents already carrying a note-list gap.
 *
 * These tests build the damage the way production made it — a note appended
 * under a heading, then a browser's `TrailingNode` paragraph after it — and
 * then check the three things the repair claims: the notes end up in one
 * list, nothing a person put there is fused, and a comment anchored to a
 * moved bullet still points at the same words.
 */

const AGENT = 'meeting-notes';

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = prose.getProseFragment(doc);
  fragment.push(prose.parseMarkdownBlocks(markdown));
  prose.ensureBlockIds(doc);
  return doc;
}

function topKinds(doc: Y.Doc): string[] {
  return (prose.getProseFragment(doc).toArray() as Y.XmlElement[]).map((el) => el.nodeName);
}

/** The empty, unclaimed paragraph a browser keeps at the end of a doc. */
function browserTrailingNode(doc: Y.Doc): void {
  const fragment = prose.getProseFragment(doc);
  const last = fragment.get(fragment.length - 1) as Y.XmlElement | Y.XmlText | undefined;
  if (last instanceof Y.XmlElement && last.nodeName === 'paragraph') return;
  fragment.push([new Y.XmlElement('paragraph')]);
}

/**
 * A doc shaped exactly like the worst meeting in the corpus: `notes`
 * one-item lists, each behind the browser paragraph left by the tick before it.
 *
 * Built by hand rather than by driving `applyBlockEdits`, because the fix in
 * that function is what stops this shape being buildable through it.
 */
function damagedDoc(notes: string[]): Y.Doc {
  const doc = docOf('## Notes\n');
  const fragment = prose.getProseFragment(doc);
  for (const [i, text] of notes.entries()) {
    if (i > 0) fragment.push([new Y.XmlElement('paragraph')]);
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    const para = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    para.insert(0, [t]);
    item.insert(0, [para]);
    list.insert(0, [item]);
    fragment.push([list]);
  }
  browserTrailingNode(doc);
  prose.ensureBlockIds(doc);
  for (const el of prose.addressableBlocks(prose.getProseFragment(doc))) {
    if (el.nodeName === 'listItem' || el.nodeName === 'bulletList') {
      el.setAttribute('cwAuthor', AGENT);
    }
  }
  return doc;
}

/** The plain text of every bullet, in document order. */
function bullets(doc: Y.Doc): string[] {
  return prose
    .readOutline(doc)
    .filter((e) => e.kind === 'listItem')
    .map((e) => e.text);
}

/** Anchor a thread to `needle`, the way a comment on a bullet does. */
function anchorThread(doc: Y.Doc, id: string, needle: string): void {
  const { plainText, segments } = prose.walkProse(prose.getProseFragment(doc));
  const at = plainText.indexOf(needle);
  if (at < 0) throw new Error(`no such text: ${needle}`);
  const seg = segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
  if (!seg) throw new Error('no segment');
  const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
  const entry = new Y.Map<unknown>();
  entry.set('id', id);
  entry.set('anchor', {
    kind: 'text-range',
    startRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset),
    ),
    endRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(seg.node, at + needle.length - seg.docOffset),
    ),
    snippet: { text: needle },
  });
  threads.set(id, entry);
}

/** What the thread's anchor points at now, or null if it no longer resolves. */
function anchorText(doc: Y.Doc, id: string): string | null {
  const entry = (doc.getMap('threads') as Y.Map<Y.Map<unknown>>).get(id);
  const anchor = entry?.get('anchor') as
    | { kind?: string; startRel?: Uint8Array; endRel?: Uint8Array }
    | undefined;
  if (!anchor || anchor.kind !== 'text-range' || !anchor.startRel || !anchor.endRel) return null;
  const fragment = prose.getProseFragment(doc);
  const { plainText, segments } = prose.walkProse(fragment);
  const at = (bytes: Uint8Array): number | null => {
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(new Uint8Array(bytes)),
      doc,
    );
    if (!abs || !(abs.type instanceof Y.XmlText)) return null;
    const seg = segments.find((s) => s.node === abs.type);
    return seg ? seg.docOffset + abs.index : null;
  };
  const lo = at(anchor.startRel);
  const hi = at(anchor.endRel);
  if (lo === null || hi === null) return null;
  return plainText.slice(Math.min(lo, hi), Math.max(lo, hi));
}

describe('findGapSites', () => {
  it('names one site per stranded list in a chain', () => {
    const doc = damagedDoc(['one', 'two', 'three']);
    expect(topKinds(doc)).toEqual([
      'heading',
      'bulletList',
      'paragraph',
      'bulletList',
      'paragraph',
      'bulletList',
      'paragraph',
    ]);
    const sites = findGapSites(doc);
    expect(sites.map((s) => [s.hostIndex, s.strandedIndex])).toEqual([
      [1, 3],
      [3, 5],
    ]);
  });

  it('reports whether the stranded items are agent-written, as evidence', () => {
    // Authorship is what a person reads before naming a document for repair.
    // The damaged doc is the agent's own; a hand-parsed one carries none, and
    // that is NOT evidence of the opposite — it is the absence of evidence.
    expect(findGapSites(damagedDoc(['one', 'two']))[0]?.authored).toBe(true);
    const parsed = docOf('- one\n');
    const fragment = prose.getProseFragment(parsed);
    fragment.push([new Y.XmlElement('paragraph')]);
    fragment.push(prose.parseMarkdownBlocks('- two\n'));
    expect(findGapSites(parsed)[0]?.authored).toBe(false);
  });

  it('finds nothing in a doc a person wrote by hand', () => {
    const doc = docOf('## Notes\n\n- one\n- two\n\nA paragraph with words.\n\n- three\n');
    expect(findGapSites(doc)).toEqual([]);
  });

  it('does not call two lists a site when the paragraph has words in it', () => {
    const doc = docOf('- one\n\nDecisions\n\n- two\n');
    expect(findGapSites(doc)).toEqual([]);
  });

  it('does not call two lists a site when their types differ', () => {
    const doc = docOf('- one\n');
    const fragment = prose.getProseFragment(doc);
    fragment.push([new Y.XmlElement('paragraph')]);
    fragment.push(prose.parseMarkdownBlocks('1. two\n'));
    expect(findGapSites(doc)).toEqual([]);
  });

  it('leaves two adjacent lists alone — this repair is about the gap', () => {
    const doc = docOf('- one\n');
    const fragment = prose.getProseFragment(doc);
    fragment.push(prose.parseMarkdownBlocks('- two\n'));
    expect(topKinds(doc)).toEqual(['bulletList', 'bulletList']);
    expect(findGapSites(doc)).toEqual([]);
  });

  it('does not step over an empty paragraph an agent claimed', () => {
    const doc = docOf('- one\n');
    const fragment = prose.getProseFragment(doc);
    const claimed = new Y.XmlElement('paragraph');
    claimed.setAttribute('cwAuthor', AGENT);
    fragment.push([claimed]);
    fragment.push(prose.parseMarkdownBlocks('- two\n'));
    expect(findGapSites(doc)).toEqual([]);
  });
});

describe('repairNoteListGaps', () => {
  it('collapses a chain of stranded notes into one list, paragraphs left behind', () => {
    const doc = damagedDoc(['one', 'two', 'three']);
    const report = repairNoteListGaps(doc);
    expect(report.sites).toBe(2);
    expect(report.itemsMoved).toBe(2);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'paragraph', 'paragraph']);
    expect(bullets(doc)).toEqual(['one', 'two', 'three']);
  });

  it('carries each note’s block id and its author across the move', () => {
    const doc = damagedDoc(['one', 'two']);
    const before = new Map(
      prose
        .readOutline(doc)
        .filter((e) => e.kind === 'listItem')
        .map((e) => [e.text, e.id]),
    );
    repairNoteListGaps(doc);
    const after = new Map(
      prose
        .readOutline(doc)
        .filter((e) => e.kind === 'listItem')
        .map((e) => [e.text, e.id]),
    );
    expect(after).toEqual(before);
    // And the moved note is still addressable by that id, still the agent's.
    const moved = prose.findBlockById(prose.getProseFragment(doc), before.get('two') as string);
    expect(moved).toBeTruthy();
    expect(prose.readBlockAuthor(moved as Y.XmlElement)).toBe(AGENT);
  });

  it('keeps a comment anchored to a moved note pointing at the same words', () => {
    const doc = damagedDoc(['the dialog forgets the range', 'the export button is grey']);
    anchorThread(doc, 't-moved', 'export button');
    anchorThread(doc, 't-stayed', 'dialog forgets');
    expect(anchorText(doc, 't-moved')).toBe('export button');

    const report = repairNoteListGaps(doc);
    expect(report.anchorsChecked).toBe(2);
    expect(report.anchorsRebuilt).toBe(2);
    expect(report.anchorsUnverified).toBe(0);
    expect(anchorText(doc, 't-moved')).toBe('export button');
    expect(anchorText(doc, 't-stayed')).toBe('dialog forgets');
  });

  it('keeps the rest of an anchor — the view it belongs to, the text a redline cut', () => {
    const doc = damagedDoc(['the dialog forgets the range', 'the export button is grey']);
    anchorThread(doc, 't', 'export button');
    const entry = (doc.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t') as Y.Map<unknown>;
    const before = entry.get('anchor') as Record<string, unknown>;
    entry.set('anchor', {
      ...before,
      context: { view: 'redline', file: 'notes.md' },
      deletedSnippet: 'what the reviewer was asking about',
    });

    expect(repairNoteListGaps(doc).anchorsRebuilt).toBe(1);

    const after = entry.get('anchor') as Record<string, unknown>;
    expect(after.context).toEqual({ view: 'redline', file: 'notes.md' });
    expect(after.deletedSnippet).toBe('what the reviewer was asking about');
    expect(after.snippet).toEqual(before.snippet);
    expect(anchorText(doc, 't')).toBe('export button');
  });

  it('is what makes the anchor survive — a bare move loses it', () => {
    // The control for the test above: this is the move without the rebuild,
    // and it is why `repairNoteListGaps` does more than splice two lists.
    const doc = damagedDoc(['first note', 'second note']);
    anchorThread(doc, 't', 'second note');
    const fragment = prose.getProseFragment(doc);
    const host = fragment.get(1) as Y.XmlElement;
    const stranded = fragment.get(3) as Y.XmlElement;
    host.insert(
      host.length,
      (stranded.toArray() as Y.XmlElement[]).map((el) => el.clone()),
    );
    fragment.delete(3, 1);
    expect(anchorText(doc, 't')).toBeNull();
  });

  it('leaves the words of the document exactly as they were', () => {
    const doc = damagedDoc(['one', 'two', 'three']);
    const before = prose.walkProse(prose.getProseFragment(doc)).plainText;
    repairNoteListGaps(doc);
    expect(prose.walkProse(prose.getProseFragment(doc)).plainText).toBe(before);
  });

  it('is idempotent — a second run finds nothing and writes nothing', () => {
    const doc = damagedDoc(['one', 'two']);
    repairNoteListGaps(doc);
    const after = Y.encodeStateAsUpdate(doc);
    const second = repairNoteListGaps(doc);
    expect(second).toEqual({
      sites: 0,
      itemsMoved: 0,
      anchorsChecked: 0,
      anchorsRebuilt: 0,
      anchorsUnverified: 0,
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(after);
  });

  it('does not fuse two lists a person deliberately kept apart', () => {
    const doc = docOf('- shipped this week\n\nStill open\n\n- the export button\n');
    const before = prose.walkProse(prose.getProseFragment(doc)).plainText;
    const report = repairNoteListGaps(doc);
    expect(report.sites).toBe(0);
    expect(topKinds(doc)).toEqual(['bulletList', 'paragraph', 'bulletList']);
    expect(prose.walkProse(prose.getProseFragment(doc)).plainText).toBe(before);
  });

  it('does not fuse a bulleted list into a numbered one', () => {
    const doc = docOf('- one\n');
    const fragment = prose.getProseFragment(doc);
    fragment.push([new Y.XmlElement('paragraph')]);
    fragment.push(prose.parseMarkdownBlocks('1. two\n'));
    expect(repairNoteListGaps(doc).sites).toBe(0);
    expect(topKinds(doc)).toEqual(['bulletList', 'paragraph', 'orderedList']);
  });
});

describe('repairDataDir', () => {
  function corpus(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'note-gap-'));
    const path = join(dir, 'd-test.ydoc');
    writeFileSync(path, Y.encodeStateAsUpdate(damagedDoc(['one', 'two'])));
    return { dir, path };
  }

  function reload(path: string): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
    return doc;
  }

  it('reports a site without opening a single file for writing', () => {
    const { dir, path } = corpus();
    const before = readFileSync(path);
    const result = repairDataDir(dir, { log: () => {} });
    expect(result.docsWithSites).toBe(1);
    expect(result.sitesFound).toBe(1);
    expect(result.docsRepaired).toBe(0);
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(`${path}${BACKUP_SUFFIX}`)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('repairs on the disk and keeps the document it replaced', () => {
    const { dir, path } = corpus();
    const before = readFileSync(path);
    const result = repairDataDir(dir, { apply: true, log: () => {} });
    expect(result.docsRepaired).toBe(1);
    expect(result.itemsMoved).toBe(1);
    expect(bullets(reload(path))).toEqual(['one', 'two']);
    expect(topKinds(reload(path))).toEqual(['heading', 'bulletList', 'paragraph', 'paragraph']);
    // The backup is the document as it was, byte for byte.
    expect(readFileSync(`${path}${BACKUP_SUFFIX}`)).toEqual(before);
    rmSync(dir, { recursive: true });
  });

  it('never overwrites a backup, so a second run cannot destroy the original', () => {
    const { dir, path } = corpus();
    const before = readFileSync(path);
    repairDataDir(dir, { apply: true, log: () => {} });
    // Even a different damaged document arriving in the same file must not
    // turn the backup into a copy of something later.
    writeFileSync(path, Y.encodeStateAsUpdate(damagedDoc(['three', 'four'])));
    repairDataDir(dir, { apply: true, log: () => {} });
    expect(readFileSync(`${path}${BACKUP_SUFFIX}`)).toEqual(before);
    rmSync(dir, { recursive: true });
  });

  it('leaves the document alone when it cannot take a backup', () => {
    const { dir, path } = corpus();
    const before = readFileSync(path);
    // A directory where the backup file belongs: the copy cannot land.
    mkdirSync(`${path}${BACKUP_SUFFIX}`);
    const lines: string[] = [];
    const result = repairDataDir(dir, { apply: true, log: (line) => lines.push(line) });
    expect(result.docsRepaired).toBe(0);
    expect(readFileSync(path)).toEqual(before);
    expect(lines.some((line) => line.includes('left alone'))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('touches only the doc ids it was given', () => {
    const { dir, path } = corpus();
    const other = join(dir, 'd-other.ydoc');
    writeFileSync(other, Y.encodeStateAsUpdate(damagedDoc(['a', 'b'])));
    const untouched = readFileSync(other);
    const result = repairDataDir(dir, { apply: true, docIds: ['d-test'], log: () => {} });
    expect(result.docsRepaired).toBe(1);
    expect(readFileSync(other)).toEqual(untouched);
    expect(bullets(reload(path))).toEqual(['one', 'two']);
    rmSync(dir, { recursive: true });
  });
});
