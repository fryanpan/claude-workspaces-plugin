import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
  walkProse,
} from '../src/prose.ts';
import {
  acceptSuggestion,
  rejectSuggestion,
  suggestReplace,
  suggestRewriteRange,
} from '../src/suggest-ops.ts';
import { SUGGEST_INSERT_MARK } from '../src/suggest.ts';

/**
 * What a proposal's OFFERED TEXT is made of.
 *
 * A suggestion exists to be read: it sits in the doc and in a margin card
 * until somebody answers it. So markdown an agent writes into a proposal has
 * to arrive as marks — a speaker tag as the tag, a link as the link — and not
 * as the characters that spell them. The block-proposal path already did
 * this; these two text-range primitives did not, and a proposed note read
 * `[@Riverbend](speaker:A) asked` on screen.
 *
 * Every case checks the three states that matter to a reader: what the live
 * doc holds while the proposal is pending, what the file gets if it is
 * accepted, and that rejecting leaves the original untouched.
 */

const author = { id: 'agent-notes', name: 'Note Taker', color: '#4a90d9' };

function docFrom(md: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(md));
  return doc;
}

const serialize = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc));

/** Every run of the doc's inline text, with the marks each one carries. */
function runs(doc: Y.Doc): Array<{ text: string; marks: Record<string, unknown> }> {
  const out: Array<{ text: string; marks: Record<string, unknown> }> = [];
  for (const seg of walkProse(getProseFragment(doc)).segments) {
    for (const op of seg.node.toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>) {
      if (typeof op.insert === 'string') out.push({ text: op.insert, marks: op.attributes ?? {} });
    }
  }
  return out;
}

/** The run the proposal offers, or undefined when it offered nothing. */
function offered(doc: Y.Doc): Array<{ text: string; marks: Record<string, unknown> }> {
  return runs(doc).filter((r) => r.marks[SUGGEST_INSERT_MARK] != null);
}

/** Everything a reader would see in the live doc, proposals included. */
const liveText = (doc: Y.Doc): string => runs(doc).map((r) => r.text).join('');

function blockText(doc: Y.Doc, blockIndex: number): Y.XmlText {
  const el = getProseFragment(doc).get(blockIndex) as Y.XmlElement;
  const t = el.toArray()[0];
  if (!(t instanceof Y.XmlText)) throw new Error('block has no text child');
  return t;
}

const SPEAKER_TAG = '[@Riverbend](speaker:A)';

describe('suggestReplace — the offered text is markdown', () => {
  it('offers a speaker tag as a link, so the doc reads it as a note and not as markup', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const res = suggestReplace(doc, { find: 'Somebody', replace: SPEAKER_TAG, author });
    expect(res.ok).toBe(true);

    const proposed = offered(doc);
    expect(proposed.map((r) => r.text)).toEqual(['@Riverbend']);
    expect(proposed[0]?.marks.link).toEqual({ href: 'speaker:A' });
    // The characters that spell the tag are nowhere on screen.
    expect(liveText(doc)).not.toContain('[');
    expect(liveText(doc)).not.toContain('](');
  });

  it('offers an ordinary link and emphasis the same way', () => {
    const doc = docFrom('Read the plan before Friday.\n');
    const res = suggestReplace(doc, {
      find: 'the plan',
      replace: '[the plan](/docs/plan) and the **budget**',
      author,
    });
    expect(res.ok).toBe(true);
    const proposed = offered(doc);
    expect(proposed.find((r) => r.text === 'the plan')?.marks.link).toEqual({ href: '/docs/plan' });
    expect(proposed.find((r) => r.text === 'budget')?.marks.bold).toBeTruthy();
    expect(liveText(doc)).not.toContain('**');
  });

  it('leaves the accepted state alone until answered, then writes the markdown to the file', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const res = suggestReplace(doc, { find: 'Somebody', replace: SPEAKER_TAG, author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(serialize(doc)).toBe('Somebody asked about the gate.\n');
    expect(acceptSuggestion(doc, res.sid).ok).toBe(true);
    expect(serialize(doc)).toBe('[@Riverbend](speaker:A) asked about the gate.\n');
  });

  it('rejecting restores exactly the words that were there', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const res = suggestReplace(doc, { find: 'Somebody', replace: SPEAKER_TAG, author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(rejectSuggestion(doc, res.sid).ok).toBe(true);
    expect(serialize(doc)).toBe('Somebody asked about the gate.\n');
    expect(liveText(doc)).toBe('Somebody asked about the gate.');
  });

  it('parseInlineMarks:false keeps the characters — what a spoken correction needs', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const res = suggestReplace(doc, {
      find: 'Somebody',
      replace: SPEAKER_TAG,
      parseInlineMarks: false,
      author,
    });
    expect(res.ok).toBe(true);
    expect(offered(doc).map((r) => r.text)).toEqual([SPEAKER_TAG]);
  });
});

describe('suggestRewriteRange — the offered text is markdown', () => {
  it('offers a speaker tag as a link on an anchored range', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const t = blockText(doc, 0);
    const res = suggestRewriteRange(doc, {
      startRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, 0)),
      endRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, 8)),
      replacement: SPEAKER_TAG,
      author,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const proposed = offered(doc);
    expect(proposed.map((r) => r.text)).toEqual(['@Riverbend']);
    expect(proposed[0]?.marks.link).toEqual({ href: 'speaker:A' });
    expect(liveText(doc)).not.toContain('](');
    expect(acceptSuggestion(doc, res.sid).ok).toBe(true);
    expect(serialize(doc)).toBe('[@Riverbend](speaker:A) asked about the gate.\n');
  });

  it('parseInlineMarks:false keeps the characters on an anchored range too', () => {
    const doc = docFrom('Somebody asked about the gate.\n');
    const t = blockText(doc, 0);
    const res = suggestRewriteRange(doc, {
      startRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, 0)),
      endRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, 8)),
      replacement: SPEAKER_TAG,
      parseInlineMarks: false,
      author,
    });
    expect(res.ok).toBe(true);
    expect(offered(doc).map((r) => r.text)).toEqual([SPEAKER_TAG]);
  });
});
