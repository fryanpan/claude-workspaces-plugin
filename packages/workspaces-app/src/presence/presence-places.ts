import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
/**
 * Which participants share the reader's page and which share only the
 * workspace — the two groups of the presence strip (design F, Bryan
 * 2026-11-15) — and the words each row says about where they are.
 *
 * Pure: it reads awareness states and spots, and writes `here` and `line` on
 * the chips the board and every page already build, so the strip only draws.
 *
 * "One page" is a board tab (Home, Tasks, Library, Activity), or one doc,
 * whiteboard or mock. A panel or thread open on a tab is still that tab.
 */
import { navFromPath } from '../board/board-presence-model.ts';
import type { BoardNav, PresenceChip } from '../board/board-presence-model.ts';
import { type RoomStates, spotOfParticipant } from './follow-model.ts';
import { roomColours, soloColour } from './presence-colours.ts';

/** The page's own title, beside `spot` in its awareness state, so a person on
 *  another page reads "On Riverbend launch plan" rather than an id. */
export const PAGE_TITLE_FIELD = 'pageTitle';

/** A title is a line of text in a row; anything longer is cut. */
const TITLE_MAX = 120;

const TAB_LABEL: Record<BoardNav, string> = {
  home: 'Home',
  tasks: 'Tasks',
  library: 'Library',
  activity: 'Activity',
};

/** The board tab a board spot is on. A spot with no path names no tab. */
function boardTab(spot: PresenceSpot): BoardNav | null {
  if (!spot.path) return null;
  return navFromPath(spot.path.split('?')[0] ?? '');
}

/** Whether two spots are on one page. Two board spots are on one page when
 *  they name one tab, or when either names none. */
export function samePlace(a: PresenceSpot, b: PresenceSpot): boolean {
  if (a.surface !== b.surface) return false;
  if (a.surface !== 'board') return (a.docId ?? '') === (b.docId ?? '');
  const ta = boardTab(a);
  const tb = boardTab(b);
  return ta === null || tb === null || ta === tb;
}

/** Every doc title the pages in the room announced, by doc id. */
export function titlesFromStates(states: RoomStates): Map<string, string> {
  const out = new Map<string, string>();
  states.forEach((raw) => {
    const s = raw as { spot?: { docId?: unknown }; [PAGE_TITLE_FIELD]?: unknown } | undefined;
    const docId = s?.spot?.docId;
    const title = s?.[PAGE_TITLE_FIELD];
    if (typeof docId === 'string' && typeof title === 'string' && title.trim()) {
      out.set(docId, title.trim().slice(0, TITLE_MAX));
    }
  });
  return out;
}

/** What a page is called in a row: the board tab, or the doc's title. */
export function spotLabel(spot: PresenceSpot, titles: ReadonlyMap<string, string>): string {
  if (spot.surface === 'board') return TAB_LABEL[boardTab(spot) ?? 'tasks'];
  const title = spot.docId ? titles.get(spot.docId) : undefined;
  if (title) return title;
  if (spot.surface === 'whiteboard') return 'a whiteboard';
  if (spot.surface === 'mock') return 'a mock';
  return 'a doc';
}

/** The words a spot quotes, cut to one line, or null. */
function quoteOf(spot: PresenceSpot): string | null {
  const q = spot.quote?.trim();
  if (!q) return null;
  return q.length > 80 ? `${q.slice(0, 79)}…` : q;
}

/** The row's second line for somebody on the reader's page: what they are
 *  at, or the page's name. The group heading already says "Here with you". */
function hereLine(chip: PresenceChip, q: string | null, page: string): string {
  if (!q) return `On ${page}`;
  return chip.kind === 'agent' ? `Pointing at “${q}”` : `At “${q}”`;
}

/** The card's sentence: the page, and what they are reading or pointing at. */
function placeSentence(chip: PresenceChip, spot: PresenceSpot, q: string | null, page: string) {
  if (!q) return `On ${page}`;
  if (chip.kind === 'agent') return `Pointing at “${q}” on ${page}`;
  return spot.surface === 'board' ? `On ${page}, at “${q}”` : `On ${page}, reading “${q}”`;
}

export interface PlaceContext {
  states: RoomStates;
  selfClientId: number;
  /** Where the reader is. */
  mine: PresenceSpot;
  /** Titles known beyond the room's own, such as the reader's page. */
  titles?: ReadonlyMap<string, string>;
}

/** The name an agent's spot carries, when the spot is an agent's. */
function agentNameOf(spot: PresenceSpot): string | undefined {
  const name = (spot as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name : undefined;
}

/**
 * Each chip with `here` (on the reader's page), `line` (the row's words),
 * `page` (the name of their page), `place` (the card's sentence) and `color`
 * (`presence-colours.ts`). A
 * participant the room has no spot for (an agent that has not pointed
 * anywhere yet) is elsewhere: the reader cannot see them here.
 */
export function placeChips(chips: PresenceChip[], ctx: PlaceContext): PresenceChip[] {
  const titles = new Map([...(ctx.titles ?? []), ...titlesFromStates(ctx.states)]);
  const colours = roomColours(
    ctx.states,
    ctx.selfClientId,
    chips.map((c) => c.key),
  );
  return chips.map((plain) => {
    const chip = { ...plain, color: colours.get(plain.key) ?? soloColour(plain.key) };
    if (chip.self) return chip;
    const spot = spotOfParticipant(ctx.states, chip.key, ctx.selfClientId);
    if (!spot) {
      const line = chip.kind === 'agent' ? 'Not pointing at anything' : 'In this workspace';
      return { ...chip, here: false, line, place: line };
    }
    const here = samePlace(spot, ctx.mine);
    const page = spotLabel(spot, titles);
    const q = quoteOf(spot);
    return {
      ...chip,
      // An agent goes by the name it points under, as every page draws it:
      // the board's roster knows only its id.
      ...(chip.kind === 'agent' ? { label: agentNameOf(spot) ?? chip.label } : {}),
      here,
      line: here ? hereLine(chip, q, page) : `On ${page}`,
      page,
      place: placeSentence(chip, spot, q, page),
    };
  });
}
