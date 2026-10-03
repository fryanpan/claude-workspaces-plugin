/**
 * Workflow B: what the owner is doing, as one event per thing he does.
 *
 * Every event goes to the coach session as it happens; there is no trigger
 * and no spacing (the coach doc, "Version 1 design"). What this module does
 * is say what one thing is, so a page that reports often does not become a
 * session turn per report:
 *
 *  - **view**: he is on a board or a doc, with the heading and passage in
 *    view. Sent when the place, the heading or the passage changes, and when
 *    a hidden tab is shown again. A repeat of the same view is dropped.
 *  - **wrote**: a paragraph he typed, sent by the doc page when he pauses or
 *    leaves the paragraph. A repeat of the same text is dropped.
 *  - **comment** and **reply**: from the activity record, with their text.
 *  - **open**: the activity record says he opened a doc no page has
 *    reported, such as a mockup.
 *  - **left**: the tab he was on went hidden.
 *
 * Two sources, both his alone: the pages' `POST /coach/here`, and the owner
 * rows `onActivity` hands over. An edit session carries counts and no text,
 * and a reading session arrives after it ended, so neither is an event: the
 * page's `wrote` and `view` say the same thing sooner and with the words.
 *
 * Pure: the caller hands in the time and labels the event.
 */
import type { Event } from '../activity.ts';

export const PASSAGE_CHARS = 600;
export const TEXT_CHARS = 1_500;
const HEADING_CHARS = 120;

export type CoachEventKind = 'view' | 'wrote' | 'comment' | 'reply' | 'open' | 'left';

/** What a page sends. */
export interface HereSignal {
  at: number;
  kind: 'view' | 'wrote';
  workspaceId: string;
  docId?: string;
  visible: boolean;
  heading?: string;
  /** The text in view, for a view; what he wrote, for a wrote. */
  text?: string;
}

export interface CoachEvent {
  kind: CoachEventKind;
  at: number;
  workspaceId: string;
  docId?: string;
  heading?: string;
  text?: string;
}

/** Where he is: a board's own page, or a doc on a board. */
export interface CoachPlace {
  workspaceId: string;
  docId?: string;
}

export interface StreamStep {
  events: CoachEvent[];
  /** He arrived somewhere other than where he was. */
  moved: boolean;
}

const keyOf = (p: CoachPlace) => (p.docId ? `doc:${p.docId}` : `board:${p.workspaceId}`);

const squash = (s: string | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};

const NONE: StreamStep = { events: [], moved: false };

export class CoachStream {
  private place: CoachPlace | null = null;
  private hidden = false;
  private heading: string | undefined;
  private passage: string | undefined;
  private lastWrote: string | undefined;

  /** Where he is now, if any page or row has said. */
  get current(): CoachPlace | null {
    return this.place;
  }

  /** A page said where he is, or what he wrote. */
  here(s: HereSignal): StreamStep {
    const place: CoachPlace = {
      workspaceId: s.workspaceId,
      ...(s.docId ? { docId: s.docId } : {}),
    };
    const same = this.place !== null && keyOf(this.place) === keyOf(place);
    if (!s.visible) {
      if (!same || this.hidden) return NONE;
      this.hidden = true;
      return { events: [{ kind: 'left', at: s.at, ...place }], moved: false };
    }
    const heading = squash(s.heading, HEADING_CHARS);
    if (s.kind === 'wrote') {
      const text = squash(s.text, TEXT_CHARS);
      const moved = this.arrive(place, same);
      if (!text || (same && text === this.lastWrote)) return { events: [], moved };
      this.lastWrote = text;
      if (heading) this.heading = heading;
      return {
        events: [{ kind: 'wrote', at: s.at, ...place, ...(heading ? { heading } : {}), text }],
        moved,
      };
    }
    const passage = squash(s.text, PASSAGE_CHARS);
    const wasHidden = this.hidden;
    const moved = this.arrive(place, same);
    if (same && !wasHidden && heading === this.heading && passage === this.passage) {
      return { events: [], moved };
    }
    this.heading = heading;
    this.passage = passage;
    return {
      events: [
        {
          kind: 'view',
          at: s.at,
          ...place,
          ...(heading ? { heading } : {}),
          ...(passage ? { text: passage } : {}),
        },
      ],
      moved,
    };
  }

  /** An owner row from the activity record. */
  activity(row: Event, at: number, workspaceOf: (docId: string) => string | undefined): StreamStep {
    if (!row.isOwner) return NONE;
    const docId = row.doc?.docId;
    const workspaceId = docId ? workspaceOf(docId) : undefined;
    if (!docId || !workspaceId) return NONE;
    const place = { workspaceId, docId };
    if (row.type === 'comment' || row.type === 'reply') {
      const text = squash(
        typeof row.payload?.text === 'string' ? row.payload.text : undefined,
        TEXT_CHARS,
      );
      if (!text) return NONE;
      return { events: [{ kind: row.type, at, ...place, text }], moved: false };
    }
    if (row.type === 'doc_open') {
      if (this.place && keyOf(this.place) === keyOf(place)) return NONE;
      this.arrive(place, false);
      return { events: [{ kind: 'open', at, ...place }], moved: true };
    }
    return NONE;
  }

  /** Arriving clears what the last place showed. True when it moved him. */
  private arrive(place: CoachPlace, same: boolean): boolean {
    this.hidden = false;
    if (same) return false;
    this.place = place;
    this.heading = undefined;
    this.passage = undefined;
    this.lastWrote = undefined;
    return true;
  }
}
