/**
 * The three passes that rewrite a speaker's name in notes already written.
 *
 * They are not composes and they are not block edits: a rename is two words,
 * and re-composing a bullet to change them would cost the reader their place,
 * their comment anchors and anything they had typed around the tag. So each
 * one edits IN PLACE, run by run, carrying every site's own marks.
 *
 * WHAT THEY ARE SCOPED BY. They used to be scoped by "inside the section whose
 * heading reads Meeting notes, and among the items an ownership ledger still
 * claims". Both halves are gone: the section is addressed by block id now, and
 * ownership is an attribute on the block itself. So the scope is
 * `prose.blocksAuthoredBy(ydoc, 'meeting-notes')` — the blocks the note-taker
 * wrote and no person has since touched, which is the same set
 * `applyBlockEdits` will let it write into directly. One question, one answer,
 * asked of the doc rather than of a side ledger that could lose track of it.
 *
 * That narrows the untagged sweep, deliberately. It used to rewrite the words
 * "Speaker B" anywhere in the section, a person's own sentence included. A
 * person's sentence is theirs; the note-taker does not edit it to keep its own
 * naming tidy.
 */

import {
  type SpeakerTagRef,
  escapeTagText,
  findSpeakerTags,
  parseSpeakerTagHref,
  prose,
  reattributeSpeakerTags,
  speakerTagHref,
  speakerTagText,
} from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type NotesReattribution, extendsWord } from './meeting-notes.ts';
import { NOTES_AUTHOR_ID } from './notes-doc-access.ts';

/** The blocks the TEXTUAL passes may write into: the note-taker's own, still
 *  untouched by a person. */
function ownScope(ydoc: Y.Doc): ReadonlySet<Y.XmlElement> {
  return new Set(prose.blocksAuthoredBy(ydoc, NOTES_AUTHOR_ID));
}

/**
 * The scope the RENAME pass runs in: every block in the doc.
 *
 * WHY THE RENAME IS NOT SCOPED BY AUTHORSHIP, WHEN THE SWEEP IS. Correcting
 * a mention is a person's edit, so it hands the block back — and a rename
 * that only reached the note-taker's own blocks therefore could not touch
 * the very mention a person had just corrected. Bryan hit exactly that on
 * 2026-09-09: he retagged a line from one voice to another, named the new
 * voice, and the tag went on reading the old name for good.
 *
 * It is safe here and nowhere else because a tag names the voice by LABEL.
 * Renaming one is not editing somebody's sentence: it is the same fact the
 * href already carries, spelled the way it is now spelled. The untagged
 * sweep keeps `ownScope`, because it matches on WORDS and cannot tell a
 * person's own sentence about Speaker B from the note-taker's.
 */
function everyBlock(ydoc: Y.Doc): ReadonlySet<Y.XmlElement> {
  return new Set(prose.addressableBlocks(prose.getProseFragment(ydoc)));
}

/**
 * Rename a voice at every INLINE SPEAKER TAG the note-taker wrote — the
 * precise half of a rename, and the half that cannot be wrong.
 *
 * A tag is a markdown link whose href carries the engine label
 * (`[@Speaker B](speaker:B)`), so this asks the doc a structural question —
 * "which runs are marked as voice B?" — where {@link relabelNotesSection}
 * below can only ask a textual one — "which runs say the words 'Speaker B'?".
 * The difference is the whole reason tags exist: two voices a person has given
 * the same name are still two labels, so each renames alone.
 *
 * Written IN PLACE, run by run, carrying each site's own marks — the link mark
 * included, which is what keeps the tag a tag. Nothing is re-parsed and no
 * item is replaced, so a sentence a person edited around the tag keeps every
 * other word of theirs.
 */
export function retagSpeakerInNotes(
  ydoc: Y.Doc,
  label: string,
  displayName: string,
): { replaced: number } {
  const want = speakerTagText(label, { [label]: displayName });
  return rewriteSpeakerTagRuns(ydoc, everyBlock(ydoc), (tag) =>
    // Keyed on the label alone: a rename says what this voice is CALLED, and
    // where the mention came from is none of its business — so the href
    // rides through untouched, provenance and all.
    tag.ref.label === label && tag.text !== want ? { text: want, href: tag.href } : null,
  );
}

/**
 * One speaker tag as the DOC holds it: a contiguous run of delta ops sharing
 * one link href, plus what the href parses to.
 */
interface SpeakerTagRun {
  href: string;
  ref: SpeakerTagRef;
  /** The run's text, sigil included. */
  text: string;
}

/** What a caller wants a tag to become. `href: null` takes the link mark off
 *  entirely, which is how a claim is withdrawn while the words stay. */
interface SpeakerTagRewrite {
  text: string;
  href: string | null;
}

/**
 * Walk every speaker tag inside `within` and rewrite the ones `decide` answers
 * for — in place, run by run, carrying each site's own marks.
 *
 * THE UNIT IS A RUN, NOT AN OP. A tag is not always one delta op: bold half
 * a tag's name and Yjs carries it as two ops sharing the link href, and a
 * loop treating each op as a whole tag writes the new name once per op. So
 * contiguous ops with the SAME href accumulate into one run and the run is
 * what gets replaced. (Two tags for one voice written back to back with
 * nothing between them merge into one — markdown that says the same name
 * twice in a row with no words between it.)
 */
function rewriteSpeakerTagRuns(
  ydoc: Y.Doc,
  within: ReadonlySet<Y.XmlElement>,
  decide: (tag: SpeakerTagRun) => SpeakerTagRewrite | null,
): { replaced: number } {
  if (within.size === 0) return { replaced: 0 };
  const fragment = prose.getProseFragment(ydoc);
  const nodes: Y.XmlText[] = [];
  for (const top of fragment.toArray()) {
    if (top instanceof Y.XmlElement) collectTextNodesWithin(top, within, nodes);
  }
  if (nodes.length === 0) return { replaced: 0 };

  let replaced = 0;
  ydoc.transact(() => {
    for (const node of nodes) {
      const edits: Array<{
        offset: number;
        length: number;
        attributes: Record<string, unknown>;
        rewrite: SpeakerTagRewrite;
      }> = [];
      let run: {
        offset: number;
        length: number;
        attributes: Record<string, unknown>;
        text: string;
        href: string;
      } | null = null;
      const flush = () => {
        if (run) {
          const ref = parseSpeakerTagHref(run.href);
          if (ref) {
            const rewrite = decide({ href: run.href, ref, text: run.text });
            if (rewrite) {
              edits.push({
                offset: run.offset,
                length: run.length,
                attributes: run.attributes,
                rewrite,
              });
            }
          }
        }
        run = null;
      };
      let offset = 0;
      for (const op of node.toDelta() as YTextOp[]) {
        // A non-string insert is an embed: one position wide, and never a
        // speaker tag. Counted so later offsets stay true.
        if (typeof op.insert !== 'string') {
          flush();
          offset += 1;
          continue;
        }
        const length = op.insert.length;
        const attributes = op.attributes;
        const href = (attributes?.link as { href?: unknown } | undefined)?.href;
        if (typeof href === 'string' && run?.href === href) {
          run.length += length;
          run.text += op.insert;
        } else {
          flush();
          if (typeof href === 'string') {
            // The FIRST op's marks carry the whole replacement: the text is
            // being written anew, so emphasis that covered part of the old
            // spelling has nothing left to cover. The link mark, which is
            // the one that matters, is on every op of the run by definition.
            run = { offset, length, attributes: attributes ?? {}, text: op.insert, href };
          }
        }
        offset += length;
      }
      flush();
      // Descending, so every offset not yet used is still valid: an edit
      // only ever changes text at or after the site it lands on.
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i]!;
        node.delete(edit.offset, edit.length);
        const text = edit.rewrite.text;
        if (text.length > 0) {
          prose.insertTextWithMarks(node, edit.offset, text, {
            attributes: attributesFor(edit.attributes, edit.rewrite.href),
          });
        } else {
          closeTheGap(node, edit.offset);
        }
        replaced++;
      }
    }
  }, 'agent');
  return { replaced };
}

/** The plain words of a `Y.XmlText`, embeds counted one position wide so an
 *  offset taken from the delta still lands where it means to. */
function plainTextOf(node: Y.XmlText): string {
  let out = '';
  for (const op of node.toDelta() as YTextOp[]) {
    out += typeof op.insert === 'string' ? op.insert : '\u0000';
  }
  return out;
}

/** Punctuation that must not be left floating after the word before it. */
const CLINGING = /^[.,;:!?)\]]/;

/** An attribution separator: punctuation whose only job was to introduce the
 *  name that has just been taken out. */
const NAME_SEPARATOR = /^[ \t]*(?::|—|–)[ \t]*/;

/**
 * Close the hole a WITHDRAWN mention leaves behind, in the doc itself.
 *
 * The markdown gate does this on a string (`speaker-tags.ts`); this is the
 * same tidy where the notes actually live, because a claim can also be
 * withdrawn long after the words were written — the engine's whole-session
 * pass decides a turn belonged to nobody, and the mention it wrote goes.
 *
 * Deleting only the mention's own span leaves the punctuation that was
 * introducing it: `[@Devi](speaker:B) wants the gate` came out as a bullet
 * opening with two spaces and a lowercase verb. So the separator or the one
 * spare space goes too, and a sentence the name was opening gets its capital
 * back — from the marks already at that position, so a bolded lead stays
 * bold.
 */
function closeTheGap(node: Y.XmlText, offset: number): void {
  const text = plainTextOf(node);
  const before = text.slice(0, offset);
  const rest = text.slice(offset);
  const separator = NAME_SEPARATOR.exec(rest);
  if (separator && separator[0].length > 0) {
    node.delete(offset, separator[0].length);
  } else if (rest.startsWith(' ') && (before.endsWith(' ') || before.trim() === '')) {
    node.delete(offset, 1);
  } else if (before.endsWith(' ') && (rest === '' || CLINGING.test(rest))) {
    node.delete(offset - 1, 1);
    return;
  }
  if (before.trim() !== '') return;
  const now = plainTextOf(node).slice(offset);
  const word = /^[A-Za-z]+/.exec(now)?.[0];
  if (word === undefined || word !== word.toLowerCase()) return;
  const attributes = prose.coveringInlineMarks([{ node, offset, length: 1 }]).attributes;
  node.delete(offset, 1);
  prose.insertTextWithMarks(node, offset, word[0]!.toUpperCase(), { attributes });
}

/** The site's marks with the link mark pointed somewhere new — or dropped,
 *  which leaves the words carrying every other mark they had. */
function attributesFor(
  attributes: Record<string, unknown>,
  href: string | null,
): Record<string, unknown> {
  const { link, ...rest } = attributes;
  // Rebuilt WITHOUT the key rather than with an undefined one: these
  // attributes go straight into a Yjs insert, and a present-but-undefined
  // mark is not the same thing as an absent one.
  if (href === null) return rest;
  return { ...rest, link: { ...(link as Record<string, unknown> | undefined), href } };
}

/** One op of a `Y.XmlText` delta, as much of it as this module reads. */
interface YTextOp {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/** Every `Y.XmlText` under `el`, itself included, in reading order. */
function collectTextNodes(el: Y.XmlElement, into: Y.XmlText[]): void {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) into.push(child);
    else if (child instanceof Y.XmlElement) collectTextNodes(child, into);
  }
}

/**
 * The text nodes under `el` a scoped edit may touch: those inside a block the
 * scope names. Descends THROUGH an unnamed element rather than stopping at it
 * — a bullet list is never itself an item, its `listItem` children are.
 */
function collectTextNodesWithin(
  el: Y.XmlElement,
  within: ReadonlySet<Y.XmlElement>,
  into: Y.XmlText[],
): void {
  if (within.has(el)) {
    collectTextNodes(el, into);
    return;
  }
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement) collectTextNodesWithin(child, within, into);
  }
}

/**
 * Carry the engine's late correction of WHO SPOKE into the notes already
 * written — the half a rename could never do.
 *
 * A rename is keyed on a voice and reaches every mention of it. This is keyed
 * on TURNS, so which mentions move is decided per site from the provenance
 * each one carries (`speaker:B?t=10,12`): the ones whose every turn moved the
 * same way take the new voice, the ones whose turns now disagree are marked
 * unsure, and the ones the revision never touched are left exactly alone.
 * `reattributeSpeakerTags` in core is the same decision on a markdown string —
 * one rule, so the session's memory of the notes and the doc itself cannot
 * come out saying different things.
 *
 * Scoped to the note-taker's own blocks, like every pass here. Rewriting the
 * attribution inside a sentence a person has taken over would be the
 * note-taker editing their writing on a machine's second thoughts — and it is
 * the same boundary that keeps this off an EARLIER meeting's leftovers in the
 * same doc, whose turn numbers start again from the beginning and could
 * otherwise collide with this meeting's.
 */
export function reattributeNotesSection(
  ydoc: Y.Doc,
  reattribution: Pick<NotesReattribution, 'revisions' | 'names'>,
): { replaced: number } {
  if (reattribution.revisions.size === 0) return { replaced: 0 };
  return rewriteSpeakerTagRuns(ydoc, ownScope(ydoc), (tag) => {
    // Run through core on a one-tag markdown string, so the doc and the
    // session's memory are decided by the same code rather than by two
    // implementations of the same rule.
    // Escaped, because this text came out of the DOCUMENT rather than out of
    // a composer: a person can type a bracket into a chip's words, and raw it
    // would close the link early and make the mention invisible to the finder
    // — the correction would skip it in silence.
    const before = `[${escapeTagText(tag.text)}](${tag.href})`;
    const after = reattributeSpeakerTags(before, reattribution).markdown;
    if (after === before) return null;
    const rewritten = findSpeakerTags(after)[0];
    // No tag left in the answer is the withdrawn claim: the words stay and
    // the link mark goes.
    return rewritten
      ? { text: rewritten.text, href: speakerTagHref(rewritten.label, rewritten) }
      : { text: after, href: null };
  });
}

export interface RelabelNotesResult {
  /** How many occurrences were rewritten. Zero is an ordinary answer: the
   *  notes may not mention that voice, or may not exist yet. */
  replaced: number;
  /** Matches that straddled two Y.XmlText nodes and were left alone. A
   *  count the caller cannot see is a stale label nobody knows about. */
  skippedCrossNode?: number;
}

/**
 * Rewrite `from` to `to` inside the note-taker's own blocks — the rename made
 * retroactive across notes composed before speaker tags existed.
 *
 * SCOPED THREE WAYS, because this runs on a doc a human is writing in:
 *  1. Only inside blocks the note-taker wrote and no person has touched. Prose
 *     a person wrote cannot be reached from here, whatever it says.
 *  2. Only the exact token, on word boundaries — the string this module's own
 *     composer put there ("Speaker B"), not a substring of one.
 *  3. In place, character-for-character, carrying each site's marks. The
 *     surrounding sentence is not re-composed, re-parsed, or replaced.
 */
export function relabelNotesSection(ydoc: Y.Doc, from: string, to: string): RelabelNotesResult {
  if (!from || !to || from === to) return { replaced: 0 };
  const within = ownScope(ydoc);
  if (within.size === 0) return { replaced: 0 };
  const fragment = prose.getProseFragment(ydoc);

  const nodes = new Set<Y.XmlText>();
  for (const top of fragment.toArray()) {
    if (top instanceof Y.XmlElement) {
      const found: Y.XmlText[] = [];
      collectTextNodesWithin(top, within, found);
      for (const n of found) nodes.add(n);
    }
  }
  if (nodes.size === 0) return { replaced: 0 };

  const { matches, crossNode, plainText } = prose.locateMatches(fragment, { find: from });
  const kept = matches.filter((m) => {
    if (!nodes.has(m.segment.node)) return false;
    if (extendsWord(plainText[m.docOffset - 1])) return false;
    if (extendsWord(plainText[m.docOffset + m.length])) return false;
    return true;
  });
  if (kept.length === 0) {
    return { replaced: 0, ...(crossNode > 0 ? { skippedCrossNode: crossNode } : {}) };
  }

  ydoc.transact(() => {
    // Descending, for the reason findAndReplace's sweep is: every offset not
    // yet used stays valid because edits only land at or above the next site.
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = kept[i]!;
      const siteMarks = prose.coveringInlineMarks([
        { node: m.segment.node, offset: m.offsetInNode, length: m.length },
      ]);
      m.segment.node.delete(m.offsetInNode, m.length);
      prose.insertTextWithMarks(m.segment.node, m.offsetInNode, to, {
        attributes: siteMarks.attributes,
      });
    }
  }, 'agent');

  return { replaced: kept.length, ...(crossNode > 0 ? { skippedCrossNode: crossNode } : {}) };
}
