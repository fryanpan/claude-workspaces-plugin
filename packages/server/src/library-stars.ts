/**
 * What each person on a board starred, for the Library's Starred list. Board
 * data: a kind, an id and a time per star, never a title or any text.
 *
 * A star is a person's own explicit choice. The route that calls `setStar`
 * takes only a browser's request whose author reads as a person, the same
 * test Recently Viewed uses (`library-views.ts`), so one person's stars are
 * never another's and an agent never stars anything.
 */

/** What can be starred: a board item (a doc of any kind, a meeting), or a folder. */
export type StarKind = 'doc' | 'folder';

export interface LibraryStar {
  kind: StarKind;
  id: string;
  /** When it was starred (epoch ms). The list shows the newest first. */
  at: number;
}

export interface StarState {
  libraryStars?: Record<string, LibraryStar[]>;
}

/** How many stars one person keeps on one board. */
export const MAX_STARS_PER_PERSON = 200;

export function isStarKind(v: unknown): v is StarKind {
  return v === 'doc' || v === 'folder';
}

/**
 * Star or unstar one item for `person`. Answers whether anything changed:
 * starring a starred item, or unstarring one that is not, is no news.
 */
export function setStar(
  s: StarState,
  person: string,
  star: { kind: StarKind; id: string },
  on: boolean,
  at: number,
): boolean {
  const all = s.libraryStars ?? {};
  const list = all[person] ?? [];
  const has = list.some((x) => x.kind === star.kind && x.id === star.id);
  if (has === on) return false;
  const next = on
    ? [{ kind: star.kind, id: star.id, at }, ...list].slice(0, MAX_STARS_PER_PERSON)
    : list.filter((x) => !(x.kind === star.kind && x.id === star.id));
  s.libraryStars = { ...all, [person]: next };
  return true;
}

/** `person`'s stars that still name something, newest first. */
export function starsFor(
  s: StarState,
  person: string | null,
  exists: (star: LibraryStar) => boolean,
): LibraryStar[] {
  if (!person) return [];
  return (s.libraryStars?.[person] ?? []).filter(exists);
}
