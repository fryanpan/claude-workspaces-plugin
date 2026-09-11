/**
 * What `applyBlockEdits` does with a block the caller does not own.
 *
 * The contract is the one a person relies on without ever reading it: an
 * agent can propose anything, and nothing it proposes removes a word until
 * somebody accepts. Every case below is held to the same three checks —
 *
 * 1. straight after the batch, the ACCEPTED state (what the file on disk
 *    gets) is exactly what it was, and every character of the original is
 *    still in the live doc;
 * 2. rejecting the proposal puts the doc back exactly, with no stray blocks;
 * 3. accepting it produces exactly what the direct edit would have produced,
 *    had the caller owned the block.
 *
 * The prod incident was a fenced code block replaced by a replacement that
 * was itself several blocks, so that is the first target here. All fixtures
 * are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type BlockEdit, applyBlockEdits, blocksAuthoredBy } from './prose-batch.ts';
import { getProseFragment, walkProse } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import { claimSubtree, ensureBlockIds, findBlockById, readOutline } from './prose-outline.ts';
import {
  acceptSuggestion,
  listSuggestions,
  rejectSuggestion,
  suggestReplace,
} from './suggest-ops.ts';

const AGENT = 'agent:note-taker';
const SUGGESTER = { id: AGENT, name: 'Note Taker', color: '#4a90d9' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).insert(0, parseMarkdownBlocks(markdown));
  ensureBlockIds(doc);
  return doc;
}

/** A second doc with the same content AND the same block ids. */
function twin(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();
/** Every character the live doc holds, proposals included. */
const liveText = (doc: Y.Doc): string =>
  walkProse(getProseFragment(doc))
    .segments.map((s) => s.node.toString())
    .join('\n');
const blockCount = (doc: Y.Doc): number => getProseFragment(doc).length;
const plain = (n: unknown): string =>
  n instanceof Y.XmlElement ? n.toArray().map(plain).join('/') : String(n);
/** The text of every block the caller holds, in document order. */
const authored = (doc: Y.Doc): string[] => blocksAuthoredBy(doc, AGENT).map(plain);

const apply = (doc: Y.Doc, edits: BlockEdit[]) =>
  applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });

const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

/** About 8,000 characters of fence body, the size of the prod blocks. */
const LONG_CODE = Array.from(
  { length: 200 },
  (_, i) => `step ${String(i).padStart(3, '0')}: sluice.drain(gate=${i})`,
).join('\n');

const MULTI_BLOCK = [
  '### Gate rollout',
  '',
  '- Open the east gate first',
  '  - then the west',
  '- Log every reading',
  '',
  '```ts',
  'const gates = ["east", "west"];',
  '```',
].join('\n');

const FIXTURE = [
  '# Drainage plan',
  '',
  'A paragraph a person wrote.',
  '',
  '```text',
  LONG_CODE,
  '```',
  '',
  '## Notes',
  '',
  '- A bullet a person wrote',
  '  - with a sub-point',
  '- A second bullet',
  '',
  '> A quoted line.',
  '>',
  '> A second quoted paragraph.',
  '',
  'Closing words.',
].join('\n');

const TARGETS: Array<[string, string]> = [
  ['a fenced code block', 'step 000'],
  ['a paragraph', 'A paragraph a person wrote.'],
  ['a heading', 'Notes'],
  ['a bullet with a sub-point', 'A bullet a person wrote'],
  ['a blockquote', 'A quoted line.'],
];

const REPLACEMENTS: Array<[string, string]> = [
  ['multi-block markdown', MULTI_BLOCK],
  ['one line', 'One plain sentence instead.'],
];

/**
 * Check 1: nothing is gone. The accepted state is byte-identical and every
 * original character is still in the live doc; every `suggested` outcome
 * names a proposal that is listed.
 */
function expectNothingLost(before: { md: string; text: string }, doc: Y.Doc, sids: string[]) {
  expect(md(doc)).toBe(before.md);
  for (const line of before.text.split('\n')) expect(liveText(doc)).toContain(line);
  const listed = listSuggestions(doc).map((s) => s.sid);
  for (const sid of sids) expect(listed).toContain(sid);
}

describe('a replace of a block the caller does not own', () => {
  for (const [targetName, needle] of TARGETS) {
    for (const [replName, replacement] of REPLACEMENTS) {
      it(`${targetName}, replaced by ${replName}: a pending proposal, then either answer`, () => {
        const doc = docOf(FIXTURE);
        const before = { md: md(doc), text: liveText(doc), blocks: blockCount(doc) };
        const blockId = idOf(doc, needle);
        // The owned twin: same doc, same ids, target claimed — the direct edit.
        const direct = twin(doc);
        const owned = findBlockById(getProseFragment(direct), blockId);
        expect(owned).toBeTruthy();
        claimSubtree(owned as Y.XmlElement, AGENT);
        expect(
          apply(direct, [{ op: 'replace_block', blockId, markdown: replacement }]).applied,
        ).toBe(1);

        const res = apply(doc, [{ op: 'replace_block', blockId, markdown: replacement }]);
        expect(res).toMatchObject({ applied: 0, suggested: 1, failed: 0 });
        const sid = res.outcomes[0]?.suggestionId as string;
        expect(sid).toBeTruthy();
        expectNothingLost(before, doc, [sid]);

        const accepted = twin(doc);
        expect(acceptSuggestion(accepted, sid)).toEqual({ ok: true });
        expect(md(accepted)).toBe(md(direct));
        // ...and the caller holds what it wrote, as after the direct edit.
        expect(authored(accepted)).toEqual(authored(direct));
        expect(listSuggestions(accepted)).toEqual([]);

        expect(rejectSuggestion(doc, sid)).toEqual({ ok: true });
        expect(md(doc)).toBe(before.md);
        expect(liveText(doc)).toBe(before.text);
        expect(blockCount(doc)).toBe(before.blocks);
        expect(listSuggestions(doc)).toEqual([]);
      });
    }
  }

  it('offers the replacement as blocks, not as characters inside the code', () => {
    const doc = docOf(FIXTURE);
    apply(doc, [{ op: 'replace_block', blockId: idOf(doc, 'step 000'), markdown: MULTI_BLOCK }]);
    const kinds = getProseFragment(doc)
      .toArray()
      .map((el) => (el instanceof Y.XmlElement ? el.nodeName : 'text'));
    // The original fence, then a heading, a list and a second fence — not one
    // code block whose text has grown a `###`.
    expect(kinds.slice(2, 6)).toEqual(['codeBlock', 'heading', 'bulletList', 'codeBlock']);
    const code = getProseFragment(doc).get(2) as Y.XmlElement;
    expect(
      code
        .toArray()
        .map((t) => t.toString())
        .join(''),
    ).not.toContain('###');
  });

  it('a whitespace replacement is `empty`, not a proposal to strike the block', () => {
    const doc = docOf(FIXTURE);
    const before = md(doc);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'A paragraph a person'), markdown: '  \n ' },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'empty' });
    expect(md(doc)).toBe(before);
    expect(listSuggestions(doc)).toEqual([]);
  });

  for (const [name, needle, markdown] of [
    ['a replacement with no words in it', 'step 000', '---'],
    ['a replacement with words AND a rule', 'step 000', 'Above.\n\n---\n\nBelow.'],
    // The offered bullet has words, so a check of top-level blocks passes it;
    // the rule built INSIDE the item is what would reach the file while the
    // proposal is still pending.
    ['a bullet holding words AND a rule', 'A bullet a person wrote', '- Proposed\n\n  ---'],
  ] as Array<[string, string, string]>) {
    it(`${name} fails whole, and leaves nothing behind`, () => {
      // A rule can carry no mark, so it would have reached disk unasked; and
      // proposing only the words would make accepting write half the edit.
      const doc = docOf(FIXTURE);
      const before = { md: md(doc), text: liveText(doc), blocks: blockCount(doc) };
      const res = apply(doc, [{ op: 'replace_block', blockId: idOf(doc, needle), markdown }]);
      expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'suggest-failed' });
      expect(res.outcomes[0]?.reason).toContain('no text');
      expect(md(doc)).toBe(before.md);
      expect(liveText(doc)).toBe(before.text);
      expect(blockCount(doc)).toBe(before.blocks);
      expect(listSuggestions(doc)).toEqual([]);
    });
  }
});

describe('a delete of a block the caller does not own', () => {
  it('strikes the WHOLE block, so accepting removes all of it', () => {
    // It used to strike only the block's FIRST text block: accepting a delete
    // of a bullet removed the bullet's own line and left its sub-point behind,
    // promoted into the list in its place.
    const doc = docOf(FIXTURE);
    const before = { md: md(doc), text: liveText(doc) };
    const blockId = idOf(doc, 'A bullet a person wrote');
    const direct = twin(doc);
    claimSubtree(findBlockById(getProseFragment(direct), blockId) as Y.XmlElement, AGENT);
    expect(apply(direct, [{ op: 'delete_block', blockId }]).applied).toBe(1);

    const res = apply(doc, [{ op: 'delete_block', blockId }]);
    const sid = res.outcomes[0]?.suggestionId as string;
    expect(res.suggested).toBe(1);
    expectNothingLost(before, doc, [sid]);

    const accepted = twin(doc);
    acceptSuggestion(accepted, sid);
    expect(md(accepted)).toBe(md(direct));
    expect(md(accepted)).not.toContain('with a sub-point');

    rejectSuggestion(doc, sid);
    expect(md(doc)).toBe(before.md);
  });
});

describe('a block that already carries somebody else’s proposal', () => {
  // Proposing around the marked words would report a whole-block change while
  // accepting it left them beside the replacement; re-marking them would take
  // them from the first proposal. So the edit is refused, and says why.
  const edits: Array<[string, (id: string) => BlockEdit]> = [
    ['a replace', (blockId) => ({ op: 'replace_block', blockId, markdown: 'Agent words.' })],
    ['a delete', (blockId) => ({ op: 'delete_block', blockId })],
  ];
  for (const [name, edit] of edits) {
    it(`refuses ${name}, and leaves the first proposal whole`, () => {
      const doc = docOf(FIXTURE);
      const first = suggestReplace(doc, {
        find: 'a person wrote.',
        replace: 'somebody typed.',
        author: { id: 'person:doc-owner', name: 'Doc owner', color: '#aa5500' },
      });
      expect(first.ok).toBe(true);
      const before = { md: md(doc), text: liveText(doc), blocks: blockCount(doc) };

      const res = apply(doc, [edit(idOf(doc, 'A paragraph a'))]);
      expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'suggest-failed' });
      expect(res.outcomes[0]?.reason).toContain('pending suggestion');
      expect(md(doc)).toBe(before.md);
      expect(liveText(doc)).toBe(before.text);
      expect(blockCount(doc)).toBe(before.blocks);
      const listed = listSuggestions(doc);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.deletedText).toBe('a person wrote.');
      expect(listed[0]?.insertedText).toBe('somebody typed.');
    });
  }
});

describe('a batch of proposals', () => {
  it('loses nothing, whatever mix of targets it names', () => {
    const doc = docOf(FIXTURE);
    const before = { md: md(doc), text: liveText(doc) };
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'step 000'), markdown: MULTI_BLOCK },
      { op: 'replace_block', blockId: idOf(doc, 'Closing words.'), markdown: MULTI_BLOCK },
      { op: 'delete_block', blockId: idOf(doc, 'A second bullet') },
      { op: 'replace_block', blockId: 'bnot-a-real-id', markdown: 'x' },
    ]);
    expect(res).toMatchObject({ applied: 0, suggested: 3, failed: 1 });
    const sids = res.outcomes.flatMap((o) => (o.suggestionId ? [o.suggestionId] : []));
    expectNothingLost(before, doc, sids);
    // Every outcome is either a listed proposal or a failure that wrote
    // nothing — there is no third state in which words went missing.
    for (const o of res.outcomes) {
      expect(o.status === 'suggested' ? Boolean(o.suggestionId) : o.status === 'failed').toBe(true);
    }
  });

  it('lands as ONE update, direct edits and proposals together', () => {
    // A reader between two updates would see the direct edits without the
    // proposals beside them — half a batch.
    const doc = docOf(FIXTURE);
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));
    const res = apply(doc, [
      { op: 'insert_at_end', markdown: 'An agent footnote.' },
      { op: 'replace_block', blockId: idOf(doc, 'step 000'), markdown: MULTI_BLOCK },
    ]);
    expect(res).toMatchObject({ applied: 1, suggested: 1, failed: 0 });
    expect(origins).toEqual(['agent']);
  });
});
