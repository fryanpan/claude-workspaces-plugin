import type { User } from '@claude-workspaces/core';
import { classifyActor } from './actor-identity.ts';

/**
 * What each person on a board opened, newest first, for the Library's
 * Recently Viewed list. Board data: a doc id and a time per view, never a
 * title, a path or any text from the doc.
 *
 * Only a person's own page opening counts. An agent reading a doc over MCP
 * or REST never reaches `recordView`: the route that calls it takes only a
 * browser's request (`isBrowserRequest`) whose author reads as a person
 * (`personKeyOf`).
 */

/** One view: which doc, and when (epoch ms). */
export interface LibraryView {
  docId: string;
  at: number;
}

/** Each person's views by their identity id, newest first. */
export interface ViewState {
  libraryViews?: Record<string, LibraryView[]>;
}

/** How many views one person keeps on one board. Older ones fall off. */
export const MAX_VIEWS_PER_PERSON = 50;

/**
 * The key a view is kept under, or null when the author is not a person who
 * can be told apart: an agent, an anonymous reader, or no author at all.
 */
export function personKeyOf(author: User | undefined): string | null {
  if (!author || typeof author.id !== 'string' || author.id === '') return null;
  if (classifyActor(author) !== 'person') return null;
  if ((author as { kind?: unknown }).kind === 'anon') return null;
  return author.id;
}

/**
 * Put `docId` at the top of `person`'s list at `at`. Answers whether the list
 * changed in a way a reader would see: a doc already on top, opened again
 * within `quietMs`, is only re-timed, so a reload loop does not wake every
 * open Library.
 */
export function recordView(
  s: ViewState,
  person: string,
  docId: string,
  at: number,
  quietMs = 60_000,
): boolean {
  const all = s.libraryViews ?? {};
  const list = all[person] ?? [];
  const top = list[0];
  const visible = !(top && top.docId === docId && at - top.at < quietMs);
  const next = [{ docId, at }, ...list.filter((v) => v.docId !== docId)].slice(
    0,
    MAX_VIEWS_PER_PERSON,
  );
  s.libraryViews = { ...all, [person]: next };
  return visible;
}

/** `person`'s views of docs still on the board, newest first. */
export function viewsFor(
  s: ViewState,
  person: string | null,
  onBoard: (docId: string) => boolean,
): LibraryView[] {
  if (!person) return [];
  return (s.libraryViews?.[person] ?? []).filter((v) => onBoard(v.docId));
}
