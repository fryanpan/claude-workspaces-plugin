/**
 * ONE TAG PER SINGLE-VOICE GROUP — the column of identical names, removed.
 *
 * The note-taker tags each note with the voice that said it, and the two-layer
 * format puts a run of notes under a lead bullet. Put those two rules
 * together and a stretch of a meeting where one person is talking comes out
 * as the same name repeated down the left edge of every line under one
 * bullet — four rows of `@Devi` telling the reader nothing after the first.
 *
 * WHY THIS IS A PASS AND NOT A PROMPT LINE. A group is built across TICKS: a
 * lead bullet is written in one, and the notes under it arrive one or two at
 * a time over the next several. The model composing the fourth note is not
 * shown enough to know that the three above it came from the same voice as
 * the one it is writing, and the rule is arithmetic over the group's current
 * state, which the server can do exactly. The same reasoning put the flat-run
 * count in `notes-regroup.ts` rather than in the instructions.
 *
 * AND WHY IT RUNS ON THE DOC RATHER THAN ON THE COMPOSED EDITS. An edit
 * carries one block's markdown. The group it joins is in the doc, written by
 * earlier ticks, and the decision needs all of it — how many notes are under
 * the lead bullet, which voices they carry, and whether the lead bullet is
 * already speaking for them. So this runs where `notes-section-tidy.ts` runs,
 * after the tick's write, over the section the meeting owns.
 *
 * IT NEVER FORMS A GROUP AND NEVER MOVES A NOTE. Grouping is by TOPIC and is
 * the composer's business (`notes-regroup.ts` asks for it, `nest_blocks`
 * does it). Two voices arguing about the ferry timetable belong under the
 * ferry timetable, each note tagged with whoever said it — splitting them
 * into a Devi group and a Wren group would be filing a conversation by
 * speaker, which is what a transcript is for. All this pass does is decide
 * where a group's tags SIT.
 *
 * THE MOVE IS REVERSIBLE, AND THAT IS WHAT THE MARKER IS FOR. A group that
 * gains a second voice needs a tag on every note again, and the only notes
 * that may be handed the lead bullet's voice are the ones this pass took a
 * tag off. So a hoisted tag is written with `g=1`
 * ({@link SPEAKER_TAG_GROUP_PARAM}) and nothing else in the pipeline writes
 * that parameter. A lead bullet the composer tagged itself is left alone
 * entirely — reversing it would mean handing its name to notes that never
 * carried one, which is attributing words to somebody who did not say them.
 *
 * WHAT IT WILL NOT TOUCH:
 *  - **Anything a person wrote or edited.** Every block in the group — the
 *    lead bullet and each note under it — has to still carry the
 *    note-taker's authorship, or the whole group is skipped. A person's line
 *    is theirs; the note-taker does not restyle it to keep its own
 *    attribution tidy. Same boundary as `ownScope` in
 *    `notes-speaker-tags.ts`.
 *  - **A group holding an unsure mention.** `unsure=1` says the meeting no
 *    longer knows which voice those words came from. Folding it into a
 *    group's one tag would state the thing the flag exists to deny, so a
 *    group with one in it is left exactly as it is.
 *  - **A pair of notes that is not a run of one voice.** Two notes at the
 *    least, every one of them tagged, every tag the same voice.
 *
 * AND THE MEASURE MOVED WITH IT. `decisionsWithoutSpeaker` in
 * `notes-quality.ts` used to read a bullet as attributed if it or anything
 * UNDER it named a voice. After a hoist the name is one line ABOVE the
 * decision, so that check now inherits attribution downwards as well —
 * otherwise this pass would report itself as a fall in attribution while
 * every note is still attributable.
 */

import {
  MAX_SPEAKER_TAG_TURNS,
  type SpeakerTagRef,
  prose,
  speakerTagHref,
} from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type SpeakerTagSite, rewriteTagsInTextNodes, tagSitesIn } from './notes-speaker-tags.ts';

/** What one pass over a section changed. All zeros is the ordinary answer. */
export interface NotesGroupTagResult {
  /** Groups whose voice moved up onto the lead bullet. */
  hoisted: number;
  /** Notes that gave up their own tag because the lead bullet now says it. */
  cleared: number;
  /** Notes handed their tag back because their group gained a second voice. */
  restored: number;
}

const NOTHING: NotesGroupTagResult = { hoisted: 0, cleared: 0, restored: 0 };

/** The fewest notes under one bullet that can read as a column of names. */
export const MIN_GROUP_NOTES = 2;

/** A heading's level, or `undefined` for a block that is not one. */
function levelOf(el: Y.XmlElement): number | undefined {
  if (el.nodeName !== 'heading') return undefined;
  const n = Number(el.getAttribute('level'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isList(el: Y.XmlElement): boolean {
  return el.nodeName === 'bulletList' || el.nodeName === 'orderedList';
}

/**
 * The text nodes of a list item's OWN line — the paragraphs directly under
 * it, and nothing from the list nested inside it.
 *
 * The distinction is the whole pass: a lead bullet and the notes under it are
 * one block as far as serialization is concerned, and a walk that took every
 * text node under the item would read the notes' tags as the lead bullet's.
 */
function ownLineOf(item: Y.XmlElement): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  for (const child of item.toArray()) {
    if (child instanceof Y.XmlText) out.push(child);
    else if (child instanceof Y.XmlElement && !isList(child)) collectText(child, out);
  }
  return out;
}

function collectText(el: Y.XmlElement, into: Y.XmlText[]): void {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) into.push(child);
    else if (child instanceof Y.XmlElement) collectText(child, into);
  }
}

/** Every speaker tag on a block's own line, in reading order. */
function tagsOn(nodes: readonly Y.XmlText[]): Array<SpeakerTagSite & { node: Y.XmlText }> {
  const out: Array<SpeakerTagSite & { node: Y.XmlText }> = [];
  for (const node of nodes) {
    for (const site of tagSitesIn(node)) out.push({ ...site, node });
  }
  return out;
}

/** The list items directly under this item — the notes of its group. */
function notesUnder(item: Y.XmlElement): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const child of item.toArray()) {
    if (!(child instanceof Y.XmlElement) || !isList(child)) continue;
    for (const note of child.toArray()) {
      if (note instanceof Y.XmlElement && note.nodeName === 'listItem') out.push(note);
    }
  }
  return out;
}

/** The turns a set of mentions between them claim, ascending and deduped. */
function unionTurns(refs: readonly SpeakerTagRef[]): { turns: number[]; claimed: boolean } {
  const all = new Set<number>();
  let claimed = false;
  for (const ref of refs) {
    if (ref.claimsTurns) claimed = true;
    for (const turn of ref.turns) all.add(turn);
  }
  // Past the cap a mention is stamped with NOTHING and says so with an empty
  // handle — the same rule `speakerTagHref` holds a single mention to, and
  // the honest answer for a group whose notes came from more turns than one
  // mention can carry.
  if (all.size > MAX_SPEAKER_TAG_TURNS) return { turns: [], claimed: true };
  return { turns: [...all].sort((a, b) => a - b), claimed };
}

/**
 * Move each single-voice group's tag onto its lead bullet, and give a group
 * that has gained a second voice its per-note tags back.
 *
 * Never throws: it runs after the tick has already written the notes, and a
 * tidier attribution is worth strictly less than the notes themselves. A doc
 * that is gone, a heading that is not there and a fragment that will not read
 * are all "nothing to do".
 */
export function retagNotesGroups(
  ydoc: Y.Doc,
  headingId: string,
  opts: { author: string },
): NotesGroupTagResult {
  let top: Y.XmlElement[];
  try {
    top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
  } catch {
    return NOTHING;
  }
  const start = top.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return NOTHING;
  const openLevel = levelOf(top[start] as Y.XmlElement) ?? 2;
  const out = { hoisted: 0, cleared: 0, restored: 0 };
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i] as Y.XmlElement;
    const level = levelOf(el);
    if (level !== undefined && level <= openLevel) break;
    if (level === undefined && isList(el)) walkList(ydoc, el, opts.author, out);
  }
  return out;
}

/** Every item of this list, deepest group first. */
function walkList(ydoc: Y.Doc, list: Y.XmlElement, author: string, out: NotesGroupTagResult): void {
  for (const item of list.toArray()) {
    if (!(item instanceof Y.XmlElement) || item.nodeName !== 'listItem') continue;
    // DEEPEST FIRST, so an inner group's hoist has already happened when the
    // outer group reads its notes' own lines: a sub-group's lead bullet
    // carries the tag by then, which is what the outer decision should see.
    for (const child of item.toArray()) {
      if (child instanceof Y.XmlElement && isList(child)) walkList(ydoc, child, author, out);
    }
    retagGroup(ydoc, item, author, out);
  }
}

/** One lead bullet and the notes under it. */
function retagGroup(
  ydoc: Y.Doc,
  lead: Y.XmlElement,
  author: string,
  out: NotesGroupTagResult,
): void {
  const notes = notesUnder(lead);
  if (notes.length < MIN_GROUP_NOTES) return;
  // THE WHOLE GROUP HAS TO BE THE NOTE-TAKER'S. A block a person has touched
  // carries no author (`clearAuthorshipOnPersonEdit`), so this is the same
  // question `applyBlockEdits` asks before letting the note-taker write into
  // a block at all.
  if (prose.readBlockAuthor(lead) !== author) return;
  if (notes.some((note) => prose.readBlockAuthor(note) !== author)) return;

  const leadLine = ownLineOf(lead);
  if (leadLine.length === 0) return;
  const leadTags = tagsOn(leadLine);
  const noteTags = notes.map((note) => tagsOn(ownLineOf(note)));
  // An attribution the meeting is no longer sure of is not folded into
  // anything, and not pushed anywhere either.
  if ([...leadTags, ...noteTags.flat()].some((tag) => tag.ref.unsure)) return;

  const groupTag = leadTags.length === 1 && leadTags[0]?.ref.group === true ? leadTags[0] : null;
  if (groupTag === null) {
    if (leadTags.length > 0) return; // a tag the composer wrote: its business.
    hoist(ydoc, leadLine, noteTags, out);
    return;
  }
  const label = groupTag.ref.label;
  const foreign = noteTags.flat().some((tag) => tag.ref.label !== label);
  if (foreign) pushDown(ydoc, groupTag, notes, noteTags, out);
  else grow(ydoc, groupTag, noteTags, out);
}

/** A group whose every note names one voice: the voice moves up. */
function hoist(
  ydoc: Y.Doc,
  leadLine: readonly Y.XmlText[],
  noteTags: ReadonlyArray<ReadonlyArray<SpeakerTagSite & { node: Y.XmlText }>>,
  out: NotesGroupTagResult,
): void {
  // EVERY note tagged, exactly once, all the same voice. A group holding an
  // untagged note is one where the tag up top would claim a line that never
  // carried a name.
  if (noteTags.some((tags) => tags.length !== 1)) return;
  // A NOTE THAT IS ITSELF A HOISTED GROUP KEEPS ITS TAG. Its mention speaks
  // for the notes under it, and folding it into the tag above would leave
  // that sub-group with nothing to hand back if IT gains a second voice.
  if (noteTags.flat().some((tag) => tag.ref.group)) return;
  const tags = noteTags.map((t) => t[0] as SpeakerTagSite & { node: Y.XmlText });
  const label = tags[0]?.ref.label;
  if (label === undefined) return;
  if (tags.some((tag) => tag.ref.label !== label)) return;
  const text = tags[0]?.text ?? '';
  if (text.length === 0) return;
  const { turns, claimed } = unionTurns(tags.map((tag) => tag.ref));
  const head = leadLine[0] as Y.XmlText;
  ydoc.transact(() => {
    // The separator first, then the tag in front of it: both land at the
    // start of the line, so writing them in this order leaves `@Devi: the
    // ramp is the problem` without ever computing a second offset.
    head.insert(0, ': ');
    prose.insertTextWithMarks(head, 0, text, {
      attributes: {
        link: { href: speakerTagHref(label, { turns, claimsTurns: claimed, group: true }) },
      },
    });
  }, 'agent');
  out.hoisted++;
  out.cleared += clearNoteTags(ydoc, tags);
}

/** A group already speaking for itself, gaining another note from the same
 *  voice: that note's tag is redundant the moment it lands. */
function grow(
  ydoc: Y.Doc,
  groupTag: SpeakerTagSite & { node: Y.XmlText },
  noteTags: ReadonlyArray<ReadonlyArray<SpeakerTagSite & { node: Y.XmlText }>>,
  out: NotesGroupTagResult,
): void {
  // A sub-group's own hoisted mention is left where it is, for the reason
  // {@link hoist} gives.
  const tags = noteTags.flat().filter((tag) => !tag.ref.group);
  if (tags.length === 0) return;
  const { turns, claimed } = unionTurns([groupTag.ref, ...tags.map((tag) => tag.ref)]);
  out.cleared += clearNoteTags(ydoc, tags);
  // The lead bullet's mention now speaks for those turns as well, so it says
  // so — a later revision of any of them finds the mention that stands for
  // the note it moved.
  const href = speakerTagHref(groupTag.ref.label, { turns, claimsTurns: claimed, group: true });
  if (href === groupTag.href) return;
  rewriteTagsInTextNodes(ydoc, [groupTag.node], (tag) =>
    tag.href === groupTag.href ? { text: tag.text, href } : null,
  );
}

/**
 * A group that has gained a second voice: every note needs its own tag again.
 *
 * The notes handed one back are the ones with NO tag — those are exactly the
 * notes a hoist took a tag off, because the lead bullet's mention is
 * group-marked and nothing else writes that marker. The lead bullet's
 * mention then goes: it was never a note about the topic, only a stand-in
 * for the run below it, and the run no longer speaks with one voice.
 *
 * The restored mention carries NO turn handle. The lead bullet's mention
 * holds the group's turns pooled together, and there is nothing in the doc
 * that says which of them belongs to which note — so an empty handle, which
 * every later revision leaves alone, is the only honest thing to write.
 */
function pushDown(
  ydoc: Y.Doc,
  groupTag: SpeakerTagSite & { node: Y.XmlText },
  notes: readonly Y.XmlElement[],
  noteTags: ReadonlyArray<ReadonlyArray<SpeakerTagSite & { node: Y.XmlText }>>,
  out: NotesGroupTagResult,
): void {
  const label = groupTag.ref.label;
  const text = groupTag.text;
  const href = speakerTagHref(label, { claimsTurns: true });
  ydoc.transact(() => {
    for (const [i, note] of notes.entries()) {
      if ((noteTags[i]?.length ?? 0) > 0) continue;
      const line = ownLineOf(note)[0];
      if (line === undefined) continue;
      line.insert(0, ': ');
      prose.insertTextWithMarks(line, 0, text, { attributes: { link: { href } } });
      out.restored++;
    }
  }, 'agent');
  rewriteTagsInTextNodes(ydoc, [groupTag.node], (tag) =>
    tag.href === groupTag.href && tag.ref.group ? { text: '', href: null } : null,
  );
}

/** Take the named mentions off the notes that carry them, node by node so
 *  every offset is still the one the site was found at. */
function clearNoteTags(
  ydoc: Y.Doc,
  tags: ReadonlyArray<SpeakerTagSite & { node: Y.XmlText }>,
): number {
  const hrefs = new Set(tags.map((tag) => tag.href));
  const nodes = [...new Set(tags.map((tag) => tag.node))];
  return rewriteTagsInTextNodes(ydoc, nodes, (tag) =>
    hrefs.has(tag.href) ? { text: '', href: null } : null,
  ).replaced;
}
