/**
 * One window of what the owner did, as the coach session reads it.
 *
 * Every event used to be a session turn of its own, and a session that
 * posted nothing still spent 86 turns and 9.7M tokens in five hours. So the
 * feed (`coach/session-feed.ts`) holds a window's events and hands them here
 * once. A run of views in one place becomes that place and the minutes he
 * spent there, with the headings he passed; the passage in view is dropped.
 * What he wrote, commented and replied keeps its words, because a trigger
 * is often about exactly that.
 *
 * Pure: the caller hands in the events and when the window closed.
 */
import type { CoverageSource } from './coverage.ts';
import type { CoachEventKind } from './stream.ts';

/** An event as the feed was told it. */
export interface DigestEvent {
  at: number;
  kind: CoachEventKind;
  boardId: string;
  board?: string;
  docId?: string;
  doc?: string;
  heading?: string;
  text?: string;
  /** Where he was (`coach/coverage.ts`); kept on the item until it is sent. */
  source?: CoverageSource;
}

interface Place {
  boardId: string;
  board?: string;
  docId?: string;
  doc?: string;
  source?: CoverageSource;
}

export type DigestItem = Place &
  (
    | {
        kind: 'view';
        /** When the stay began. */
        at: number;
        /** Until he went elsewhere, the tab went hidden, or the window closed. */
        minutes: number;
        headings?: string[];
      }
    | { kind: Exclude<CoachEventKind, 'view'>; at: number; heading?: string; text?: string }
  );

const MAX_HEADINGS = 5;

const placeOf = (e: DigestEvent): Place => ({
  boardId: e.boardId,
  ...(e.board ? { board: e.board } : {}),
  ...(e.docId ? { docId: e.docId } : {}),
  ...(e.doc ? { doc: e.doc } : {}),
  ...(e.source ? { source: e.source } : {}),
});

/** An item as the coach session reads it: the source is the coverage
 *  report's, not the session's. */
export function withoutSource(item: DigestItem): DigestItem {
  const { source: _source, ...rest } = item;
  return rest as DigestItem;
}

const samePlace = (a: Place, b: Place) => a.boardId === b.boardId && a.docId === b.docId;

/** `events` in the order they happened; `closedAt` ends a stay still open. */
export function digestOf(events: readonly DigestEvent[], closedAt: number): DigestItem[] {
  const items: DigestItem[] = [];
  let stay: (DigestItem & { kind: 'view' }) | null = null;
  const end = (at: number) => {
    if (stay) stay.minutes = Math.max(0, Math.round((at - stay.at) / 60_000));
    stay = null;
  };
  for (const e of events) {
    if (stay && (e.kind === 'left' || !samePlace(stay, e))) end(e.at);
    if (e.kind === 'view') {
      if (!stay) {
        stay = { ...placeOf(e), kind: 'view', at: e.at, minutes: 0 };
        items.push(stay);
      }
      const headings: string[] = stay.headings ?? [];
      if (e.heading && !headings.includes(e.heading) && headings.length < MAX_HEADINGS) {
        stay.headings = [...headings, e.heading];
      }
      continue;
    }
    items.push({
      ...placeOf(e),
      kind: e.kind,
      at: e.at,
      ...(e.heading ? { heading: e.heading } : {}),
      ...(e.text ? { text: e.text } : {}),
    });
  }
  end(closedAt);
  return items;
}
