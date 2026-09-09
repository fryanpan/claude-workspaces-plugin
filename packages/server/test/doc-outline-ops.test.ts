/**
 * `doc-outline-ops.ts` directly — the two verbs `DocEditOps` delegates to,
 * driven on a hand-built `LiveDoc` rather than through a route.
 *
 * The route suite (`doc-block-edits.test.ts`) covers the wiring and the
 * validation. What only a unit test can reach is the pair of doc-TYPE answers:
 * a flat (code / diff) doc has no prose to address, and the two verbs must
 * disagree about what that means — a read answers "nothing here", a write
 * refuses. Both went through one `contentKind` check, so a copy-paste that
 * made them agree would be invisible from outside.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type DocType, prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyDocBlockEdits, readDocOutline } from '../src/doc-outline-ops.ts';
import type { LiveDoc } from '../src/doc-store.ts';

const NOTE_TAKER = 'agent:note-taker';

/**
 * A LiveDoc with nothing behind it but a Y.Doc — the only two fields these
 * verbs read are `ydoc` and `meta.type`. `awareness` throws rather than
 * returning a stub: if one of these ever reaches for presence, the test
 * should say so loudly instead of passing over a fake.
 */
function liveDoc(markdown: string, type: DocType = 'markdown'): LiveDoc {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  ydoc.transact(() => prose.applyMarkdownToFragment(fragment, markdown), 'seed');
  return {
    docId: 'd-outline',
    ydoc,
    get awareness(): never {
      throw new Error('doc-outline-ops must not touch awareness');
    },
    peekAwareness: () => null,
    conns: new Set(),
    meta: { docId: 'd-outline', type, createdAt: 0 },
    seq: 0,
  };
}

const DOC = ['# Meeting', '', 'Kickoff line.', '', '## Decisions', '', 'Ship Friday.'].join('\n');

/** The doc's blocks as `text → id`, which is how a test names one. */
function ids(doc: LiveDoc): Map<string, string> {
  return new Map(readDocOutline(doc).blocks.map((b) => [b.text, b.id]));
}

describe('readDocOutline', () => {
  it('gives every block an id, and marks the headings as headings', () => {
    const doc = liveDoc(DOC);
    const { blocks } = readDocOutline(doc);
    expect(blocks.map((b) => b.text)).toEqual([
      'Meeting',
      'Kickoff line.',
      'Decisions',
      'Ship Friday.',
    ]);
    // Every entry is addressable, and no two share an address.
    expect(blocks.every((b) => b.id.length > 0)).toBe(true);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.level)).toEqual([1, 2]);
    // A body block says which section it is in — the id, not the wording.
    const decisions = blocks.find((b) => b.text === 'Decisions');
    expect(blocks.find((b) => b.text === 'Ship Friday.')?.underHeadingId).toBe(
      decisions?.id as string,
    );
  });

  it('honours headingsOnly and recentBlocks', () => {
    const doc = liveDoc(DOC);
    expect(readDocOutline(doc, { headingsOnly: true }).blocks.map((b) => b.text)).toEqual([
      'Meeting',
      'Decisions',
    ]);
    // Headings survive the cap; the body is counted from the end.
    expect(readDocOutline(doc, { recentBlocks: 1 }).blocks.map((b) => b.text)).toEqual([
      'Meeting',
      'Decisions',
      'Ship Friday.',
    ]);
  });

  it('answers an empty outline for a flat doc instead of an error', () => {
    expect(readDocOutline(liveDoc(DOC, 'code')).blocks).toEqual([]);
  });
});

describe('applyDocBlockEdits', () => {
  it('inserts under the named heading and claims what it wrote', () => {
    const doc = liveDoc(DOC);
    const headingId = ids(doc).get('Decisions') as string;
    const res = applyDocBlockEdits(
      doc,
      [{ op: 'insert_under_heading', headingId, markdown: 'Also: freeze the schema.' }],
      { author: NOTE_TAKER, authorName: 'Note Taker' },
    );
    expect(res).toMatchObject({ ok: true, applied: 1, suggested: 0, failed: 0 });
    const after = readDocOutline(doc).blocks;
    expect(after.map((b) => b.text)).toEqual([
      'Meeting',
      'Kickoff line.',
      'Decisions',
      'Ship Friday.',
      'Also: freeze the schema.',
    ]);
    // Claimed, so the next batch may rewrite it directly.
    expect(after.at(-1)?.author).toBe(NOTE_TAKER);
    // …and nothing it did not write became its own.
    expect(after.find((b) => b.text === 'Kickoff line.')?.author).toBeUndefined();
  });

  it('proposes rather than overwrites a block it does not own', () => {
    const doc = liveDoc(DOC);
    const blockId = ids(doc).get('Kickoff line.') as string;
    const res = applyDocBlockEdits(
      doc,
      [{ op: 'replace_block', blockId, markdown: 'Rewritten by the agent.' }],
      { author: NOTE_TAKER },
    );
    expect(res).toMatchObject({ ok: true, applied: 0, suggested: 1, failed: 0 });
    // The accepted text is untouched: a suggestion is a proposal, not a write.
    expect(prose.plainTextOf(doc.ydoc)).toContain('Kickoff line.');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc))).not.toContain(
      'Rewritten by the agent',
    );
    // It is a real proposal a person can accept, not a silent no-op.
    const pending = suggestOps.listSuggestions(doc.ydoc);
    expect(pending.length).toBe(1);
    expect(res.ok === true && res.outcomes[0]?.suggestionId).toBe(pending[0]?.sid as string);
  });

  it('refuses a flat doc rather than answering it empty', () => {
    const doc = liveDoc(DOC, 'diff');
    expect(
      applyDocBlockEdits(doc, [{ op: 'insert_at_end', markdown: 'x' }], { author: NOTE_TAKER }),
    ).toEqual({ ok: false, error: 'unsupported' });
  });
});
