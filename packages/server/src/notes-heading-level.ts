/**
 * What heading level a meeting writes at — read off the doc, never assumed.
 *
 * THE LEVEL WAS A LITERAL IN FOUR PLACES and every one of them was a guess
 * about somebody else's document. The section opened at `##`, the topics under
 * it at `###`, the section's end was found by falling back to `2` when an
 * outline entry carried no level, and the heading memory only learned a new
 * heading if it was level 2. A doc whose author writes at `###` — a meeting
 * page nested under a project page, which is the ordinary shape in a bound
 * corpus — got a `##` dropped into the middle of it, sitting ABOVE the
 * headings around it and swallowing everything after it into a section the
 * author never made.
 *
 * So the level is derived, and there is exactly one rule: a new topic heading
 * is written at the level the doc's own sections are written at.
 *
 * THE TITLE IS NOT A SECTION, AND ONLY A `#` IS A TITLE. A lone level-one
 * heading at the top of the doc is what the page is called, not a peer of the
 * sections under it, so topics go one level deeper than it. A lone `##` is
 * NOT that: it is the doc's first section, and a meeting's topic is its
 * sibling. Reading it as a title put the second meeting's heading a level
 * below the first's, which ran the first meeting's section straight past it —
 * caught by `notes-second-meeting.test.ts`, not by reasoning.
 */

import type { prose } from '@claude-workspaces/core';

/**
 * The level a topic goes at in a doc with no headings at all.
 *
 * TWO, not one: an empty doc is about to be given a title by somebody, and a
 * topic that took `#` would be that title. It is the only number in this file
 * and it is a fallback for a doc that says nothing, not a policy about docs
 * that do.
 */
export const NOTES_DEFAULT_TOPIC_LEVEL = 2;

/** Markdown has six. A derivation that walks deeper writes `#######`, which
 *  is not a heading at all — it is a paragraph starting with hashes. */
const DEEPEST_HEADING_LEVEL = 6;

const levelOf = (entry: prose.OutlineEntry): number => entry.level ?? NOTES_DEFAULT_TOPIC_LEVEL;

/**
 * The level a new topic heading is written at in this doc.
 *
 * Reads the outline it is handed, so a caller that only has the meeting's own
 * section gets an answer about that slice — which is what the regroup
 * directive wants, and why this takes an outline rather than a doc id.
 */
export function notesTopicLevel(outline: readonly prose.OutlineEntry[]): number {
  const headings = outline.filter((e) => e.kind === 'heading');
  const first = headings[0];
  if (first === undefined) return NOTES_DEFAULT_TOPIC_LEVEL;
  const levels = headings.map(levelOf);
  const shallowest = Math.min(...levels);
  const title = shallowest === 1 && levelOf(first) === 1 && levels.filter((l) => l === 1).length === 1;
  if (!title) return shallowest;
  const under = levels.filter((l) => l !== 1);
  return under.length > 0 ? Math.min(...under) : NOTES_DEFAULT_TOPIC_LEVEL;
}

/** The level a heading NESTED under a topic goes at — one deeper, never past
 *  the sixth. */
export function notesSubTopicLevel(outline: readonly prose.OutlineEntry[]): number {
  return Math.min(notesTopicLevel(outline) + 1, DEEPEST_HEADING_LEVEL);
}

/** `notesTopicLevel` as the markdown prefix a prompt quotes and an edit
 *  writes: `##`, `###`, `####`. */
export function notesTopicHashes(outline: readonly prose.OutlineEntry[]): string {
  return '#'.repeat(notesTopicLevel(outline));
}

/**
 * How a meeting is told to start a topic, at the level THIS doc writes its
 * sections at.
 *
 * NO RESERVED SECTION AND NO ASSUMED LEVEL (owner, 2026-09-15). The prompt
 * used to quote a literal `## Meeting notes`, which put a container beside
 * the document's own structure and put it at a level the document may not use
 * at all. What it asks for now is a heading NAMING THE TOPIC, written where
 * the doc's other sections sit.
 */
export function topicHeadingLine(outline: readonly prose.OutlineEntry[]): string {
  return `${notesTopicHashes(outline)} <the topic in a few words>`;
}

/**
 * The two levels a tick may write a heading at, spelled for this doc.
 *
 * THE STORED INSTRUCTIONS CANNOT CARRY THESE. They are one string shared by
 * every meeting (`notes-prompt-store.ts`), and the level is a fact about THIS
 * document — so the instructions say "at the level the document section
 * names", and this is that section saying it.
 */
export function headingLevelLine(outline: readonly prose.OutlineEntry[]): string {
  const sub = '#'.repeat(notesSubTopicLevel(outline));
  const topic = notesTopicHashes(outline);
  return `A new topic heading is written "${topic} ", a sub-topic under one "${sub} ".`;
}
