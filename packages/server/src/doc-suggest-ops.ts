/**
 * Suggested edits (redline-suggestions phase 2): listing, proposing,
 * accepting and rejecting changes that are not yet the doc's text.
 *
 * Split out of `doc-edit-ops.ts`. These are the only verbs about proposals
 * rather than about text, the only ones that announce, and the only async one
 * (`resolveAllSuggestions`); what stays there is synchronous prose editing.
 *
 * Thin wrappers over the core suggest-ops: suggestions ARE marks in the prose
 * fragment, so every operation rescans at execution time — no registry to
 * keep in sync, and a sid that raced away (double-accept, external rewrite)
 * reports not-found. All mutations run under the same 'agent' transaction
 * origin the other agent edit tools use: the write-back observer flushes
 * results to disk; a browser UndoManager never tracks them.
 */
import { type Thread, suggestOps } from '@claude-workspaces/core';
import type { LiveDoc } from './doc-store.ts';
import { type TimeSlice, timeSlice } from './event-loop.ts';

/** What a suggestion verb may reach in the store, and nothing else. */
export interface DocSuggestPersistence {
  /** The doc a verb edits — `DocEditOps`'s resolver, so a dry run's copy is
   *  what a suggestion sees too, exactly as when these verbs lived there. */
  live(docId: string): LiveDoc | undefined;
  thread(docId: string, threadId: string): Thread | null;
  /** Bump the doc's sequence and broadcast one suggestion event. */
  announceSuggestion(
    doc: LiveDoc,
    event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected',
    sid: string,
    summary: suggestOps.SuggestionSummary | undefined,
  ): void;
}

/** The suggestion verbs. One per `DocStore`; stateless. */
export class DocSuggestOps {
  constructor(private readonly p: DocSuggestPersistence) {}

  /** All pending proposals on the doc, in doc order. Empty for unknown docs
   *  and for flat (code/diff) docs, whose prose fragment has no content. */
  listSuggestions(docId: string): suggestOps.SuggestionSummary[] {
    const doc = this.p.live(docId);
    if (!doc) return [];
    return suggestOps.listSuggestions(doc.ydoc);
  }

  /**
   * The suggestion-creation primitive: same find/context/occurrence matching
   * as findAndReplace, but the replacement is written AS A PROPOSAL — the
   * matched text marked suggestDelete, the new text inserted with
   * suggestInsert, one shared sid, author from the caller. The doc's
   * accepted state (and therefore disk) is unchanged until accepted.
   */
  createSuggestion(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
    },
  ):
    | { ok: true; suggestionId: string }
    | {
        ok: false;
        // `match-in-pending-suggestion`: the find only matched text that is
        // itself an unaccepted proposal — anchoring here would make this
        // proposal vanish when the other one is rejected.
        error: 'not-found' | 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
        candidates?: Array<{ docOffset: number; preview: string }>;
      } {
    const doc = this.p.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const res = suggestOps.suggestReplace(doc.ydoc, opts);
    if (!res.ok) return res;
    this.p.announceSuggestion(
      doc,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /**
   * The `rewrite_thread_region` twin of `createSuggestion`: propose the
   * rewrite of a thread's anchored range instead of applying it directly.
   * Same anchor resolution as `rewriteThreadRegion` — `anchor-orphaned` if
   * the user deleted the anchored text, `cross-block` if the range somehow
   * spans two blocks (shouldn't happen for a single-thread anchor, but
   * mirrors `rewriteRange`'s own restriction).
   */
  createSuggestionForThread(
    docId: string,
    threadId: string,
    opts: {
      replacement: string;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
      ts?: number;
    },
  ):
    | { ok: true; suggestionId: string }
    | { ok: false; error: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' } {
    const doc = this.p.live(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    const res = suggestOps.suggestRewriteRange(doc.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement: opts.replacement,
      // Passed through, never coerced: core defaults a proposal's offered
      // text to PARSED, and `=== true` would have quietly re-imposed the
      // literal-characters behaviour on every caller that omits the field.
      parseInlineMarks: opts.parseInlineMarks,
      author: opts.author,
      ts: opts.ts,
    });
    if (!res.ok) return res;
    this.p.announceSuggestion(
      doc,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /** Accept a proposal: it becomes real content and flows to disk via the
   *  normal debounced write-back. Missing sid (or doc) → not-found — also
   *  the correct answer to the double-accept race. */
  acceptSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const doc = this.p.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.acceptSuggestion(doc.ydoc, sid);
    if (res.ok) this.p.announceSuggestion(doc, 'suggestion.accepted', sid, before);
    return res;
  }

  /** Reject a proposal: restores exactly the pre-suggestion text. */
  rejectSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const doc = this.p.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.rejectSuggestion(doc.ydoc, sid);
    if (res.ok) this.p.announceSuggestion(doc, 'suggestion.rejected', sid, before);
    return res;
  }

  /**
   * Accept or reject every pending proposal (optionally one author's).
   *
   * **Yields between proposals, and that is the point.** One unbroken pass
   * here held the event loop for 114,650 ms on 2026-09-16 and took every board
   * on the machine down with it; `event-loop.ts` carries that story. The cost
   * is quadratic — `resolveOne` re-scans the whole prose fragment per sid — so
   * yielding does not make it cheaper, it makes it interruptible, which is
   * what decides whether a slow request is slow or an outage.
   *
   * Interleaving is safe rather than merely tolerated: core re-scans per sid
   * precisely so earlier mutations cannot stale out later ones, and treats a
   * sid another actor resolved first as a skip. Handing the loop back
   * exercises paths two concurrent agents already reached. A reader can now
   * observe a PARTIALLY resolved doc mid-pass; that is the honest state, and
   * the alternative was a server that answered nobody.
   */
  async resolveAllSuggestions(
    docId: string,
    opts: { action: 'accept' | 'reject'; authorId?: string },
    slice: TimeSlice = timeSlice(),
  ): Promise<{ ok: true; resolved: number; sids: string[] } | { ok: false; error: 'not-found' }> {
    const doc = this.p.live(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = new Map(suggestOps.listSuggestions(doc.ydoc).map((s) => [s.sid, s]));
    // The same selection, in the same order, that core's synchronous
    // `resolveAllSuggestions` would have made — shared rather than restated,
    // because the order decides which block keeps which id.
    const sids = suggestOps.suggestionsToResolve(doc.ydoc, opts);
    const event = opts.action === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected';
    const resolved: string[] = [];
    for (const sid of sids) {
      const one =
        opts.action === 'accept'
          ? suggestOps.acceptSuggestion(doc.ydoc, sid)
          : suggestOps.rejectSuggestion(doc.ydoc, sid);
      if (one.ok) {
        resolved.push(sid);
        this.p.announceSuggestion(doc, event, sid, before.get(sid));
      }
      await slice.yieldIfDue();
    }
    return { ok: true, resolved: resolved.length, sids: resolved };
  }
}
