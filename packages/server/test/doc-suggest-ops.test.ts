/**
 * `doc-suggest-ops.ts` directly, on a hand-built `LiveDoc` and a recording
 * persistence, rather than through `DocStore` or a route.
 *
 * The store and route suites (`suggest-doc-store`, `suggest-routes`,
 * `resolve-all-yields`) cover the wiring. What this file pins is the seam the
 * split introduced: every verb resolves through the `live` it was handed, so a
 * doc the resolver does not know is a miss, and each change announces exactly
 * once with the summary as it stood.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type Thread, prose, suggestOps } from '@claude-workspaces/core';
import * as Y from 'yjs';
import type { LiveDoc } from '../src/doc-store.ts';
import { DocSuggestOps, type DocSuggestPersistence } from '../src/doc-suggest-ops.ts';
import { timeSlice } from '../src/event-loop.ts';

const AUTHOR: suggestOps.SuggestionAuthor = { id: 'agent:riverbend', name: 'Riverbend', color: '#3366cc' };

function liveDoc(markdown: string): LiveDoc {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  ydoc.transact(() => prose.applyMarkdownToFragment(fragment, markdown), 'seed');
  return {
    docId: 'd-suggest',
    ydoc,
    get awareness(): never {
      throw new Error('doc-suggest-ops must not touch awareness');
    },
    peekAwareness: () => null,
    conns: new Set(),
    meta: { docId: 'd-suggest', type: 'markdown', createdAt: 0 },
    seq: 0,
  };
}

type Announced = { event: string; sid: string; summary?: suggestOps.SuggestionSummary };

function harness(doc: LiveDoc, threads: Record<string, Thread> = {}) {
  const announced: Announced[] = [];
  const asked: string[] = [];
  const p: DocSuggestPersistence = {
    live: (docId) => {
      asked.push(docId);
      return docId === doc.docId ? doc : undefined;
    },
    thread: (_docId, threadId) => threads[threadId] ?? null,
    announceSuggestion: (_doc, event, sid, summary) => announced.push({ event, sid, summary }),
  };
  return { ops: new DocSuggestOps(p), announced, asked };
}

const text = (doc: LiveDoc) =>
  prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc)).trim();

describe('DocSuggestOps', () => {
  it('answers a doc the resolver does not know with each verb’s own miss', async () => {
    const { ops, announced, asked } = harness(liveDoc('Ship Friday.'));
    expect(ops.listSuggestions('gone')).toEqual([]);
    expect(ops.createSuggestion('gone', { find: 'a', replace: 'b', author: AUTHOR })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(
      ops.createSuggestionForThread('gone', 't', { replacement: 'b', author: AUTHOR }),
    ).toEqual({ ok: false, error: 'anchor-not-found' });
    expect(ops.acceptSuggestion('gone', 's')).toEqual({ ok: false, error: 'not-found' });
    expect(ops.rejectSuggestion('gone', 's')).toEqual({ ok: false, error: 'not-found' });
    expect(await ops.resolveAllSuggestions('gone', { action: 'accept' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(asked.every((id) => id === 'gone')).toBe(true);
    expect(asked).toHaveLength(6);
    expect(announced).toEqual([]);
  });

  it('proposes without changing the accepted text, and announces the summary once', () => {
    const doc = liveDoc('Ship Friday.');
    const { ops, announced } = harness(doc);
    const res = ops.createSuggestion(doc.docId, {
      find: 'Friday',
      replace: 'Monday',
      author: AUTHOR,
    });
    if (!res.ok) throw new Error(`createSuggestion failed: ${res.error}`);
    const listed = ops.listSuggestions(doc.docId);
    expect(listed.map((s) => s.sid)).toEqual([res.suggestionId]);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.event).toBe('suggestion.created');
    expect(announced[0]?.summary?.sid).toBe(res.suggestionId);
  });

  it('accept makes the proposal the text; reject restores the original', () => {
    const accepted = liveDoc('Ship Friday.');
    const a = harness(accepted);
    const one = a.ops.createSuggestion(accepted.docId, {
      find: 'Friday',
      replace: 'Monday',
      author: AUTHOR,
    });
    if (!one.ok) throw new Error(one.error);
    expect(a.ops.acceptSuggestion(accepted.docId, one.suggestionId).ok).toBe(true);
    expect(text(accepted)).toBe('Ship Monday.');
    expect(a.announced.map((x) => x.event)).toEqual(['suggestion.created', 'suggestion.accepted']);
    // The accept announcement carries the summary from BEFORE it resolved.
    expect(a.announced[1]?.summary?.sid).toBe(one.suggestionId);
    // A second accept of the same sid is the double-accept race: a miss, silent.
    expect(a.ops.acceptSuggestion(accepted.docId, one.suggestionId).ok).toBe(false);
    expect(a.announced).toHaveLength(2);

    const rejected = liveDoc('Ship Friday.');
    const r = harness(rejected);
    const two = r.ops.createSuggestion(rejected.docId, {
      find: 'Friday',
      replace: 'Monday',
      author: AUTHOR,
    });
    if (!two.ok) throw new Error(two.error);
    expect(r.ops.rejectSuggestion(rejected.docId, two.suggestionId).ok).toBe(true);
    expect(text(rejected)).toBe('Ship Friday.');
    expect(r.announced.map((x) => x.event)).toEqual(['suggestion.created', 'suggestion.rejected']);
  });

  it('refuses a thread proposal when the thread is missing or not a text range', () => {
    const doc = liveDoc('Ship Friday.');
    const pageThread = { anchor: { kind: 'page' } } as unknown as Thread;
    const { ops, announced } = harness(doc, { page: pageThread });
    expect(
      ops.createSuggestionForThread(doc.docId, 'nope', { replacement: 'x', author: AUTHOR }),
    ).toEqual({
      ok: false,
      error: 'anchor-not-found',
    });
    expect(
      ops.createSuggestionForThread(doc.docId, 'page', { replacement: 'x', author: AUTHOR }),
    ).toEqual({
      ok: false,
      error: 'anchor-orphaned',
    });
    expect(announced).toEqual([]);
  });

  it('resolve-all announces each resolved proposal and yields between them', async () => {
    const doc = liveDoc(['Ship Friday.', '', 'Review Tuesday.'].join('\n'));
    const { ops, announced } = harness(doc);
    for (const [find, replace] of [
      ['Friday', 'Monday'],
      ['Tuesday', 'Thursday'],
    ] as const) {
      const res = ops.createSuggestion(doc.docId, { find, replace, author: AUTHOR });
      if (!res.ok) throw new Error(res.error);
    }
    // A zero budget yields after every proposal, so the count is exact.
    const slice = timeSlice(0);
    const res = await ops.resolveAllSuggestions(doc.docId, { action: 'accept' }, slice);
    if (!res.ok) throw new Error(res.error);
    expect(res.resolved).toBe(2);
    expect(slice.yields()).toBe(2);
    expect(text(doc)).toBe(['Ship Monday.', '', 'Review Thursday.'].join('\n'));
    expect(announced.filter((a) => a.event === 'suggestion.accepted').map((a) => a.sid)).toEqual(
      res.sids,
    );
    expect(ops.listSuggestions(doc.docId)).toEqual([]);
  });
});
