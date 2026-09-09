/**
 * "Notes agent added notes 1m 15s ago" — one small card in the balloon
 * column beside each block the note-taker just wrote.
 *
 * The tint (settle-wash.ts) says a block is new; this says who wrote it and
 * when, in the column where everything said ABOUT a block already lives. It
 * is a card and not a label in the prose for that reason, and it is a wide-
 * layout affordance only: at phone widths there is no column, and the tint
 * plus the indicator's counts carry it there (Bryan, on round 3 of the mock).
 *
 * THE AGE STEPS, IT DOES NOT COUNT. A per-second counter beside a paragraph
 * somebody is reading is a distraction that adds nothing — the reader wants
 * "a minute ago", not a stopwatch — so the text moves once every fifteen
 * seconds and each change is a one-second crossfade rather than a jump
 * (Bryan, 2026-09-08). Two stacked lines do it: the old one fades out while
 * the new one fades in, and the spent layer is dropped on a later tick.
 *
 * The clock ticks every second even so, because the fade-out is smooth: the
 * card and the tint start receding at ninety seconds and are gone at two
 * minutes, the same life the tint has always had.
 */
import type { MountScope } from './mount-scope.ts';

/** How long a note stays announced — the tint's own life. */
export const NOTE_CARD_MS = 120_000;
/** Where the card starts receding. */
export const NOTE_CARD_FADE_MS = 90_000;
/** One step of the age text. */
export const NOTE_AGE_STEP_MS = 15_000;
/** How long one text change takes. */
export const NOTE_CROSSFADE_MS = 1_000;

/** The age the text is showing: the elapsed time floored to a whole step. */
export function noteAgeStepMs(ageMs: number): number {
  return Math.max(0, Math.floor(ageMs / NOTE_AGE_STEP_MS) * NOTE_AGE_STEP_MS);
}

/** "just now", "15s ago", "1m ago", "1m 15s ago". */
export function noteAgeText(ageMs: number): string {
  const s = noteAgeStepMs(ageMs) / 1000;
  if (s === 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m ago` : `${m}m ${rest}s ago`;
}

/** The whole line a card carries. */
export function noteCardText(agent: string, ageMs: number): string {
  return `${agent} agent added notes ${noteAgeText(ageMs)}`;
}

/** How opaque a card of this age is: whole until the fade starts, gone at
 *  two minutes. */
export function noteCardOpacity(ageMs: number): number {
  if (ageMs >= NOTE_CARD_MS) return 0;
  if (ageMs <= NOTE_CARD_FADE_MS) return 1;
  return (NOTE_CARD_MS - ageMs) / (NOTE_CARD_MS - NOTE_CARD_FADE_MS);
}

/** A card and the block it belongs beside — what the balloon column places. */
export interface NoteCard {
  key: string;
  el: HTMLElement;
  anchor: Element;
  /**
   * An extra class for this card's leader line, when the card wants one —
   * a footnote whose author wrote "Unconfirmed" draws a dotted leader
   * (`doc/footnote-notes.ts`). Omit and the line is the plain `cw-leader`
   * every provenance card has always drawn.
   */
  leaderClass?: string;
}

export interface RecentNoteCardsOpts {
  /** The prose root the tinted blocks live in. */
  prose: HTMLElement;
  /** Is the balloon column on screen? No column, no cards. */
  visible: () => boolean;
  /** Who wrote them. */
  agentName?: () => string;
  /** The clock; injected by tests. */
  now?: () => number;
  /** The card set changed — the column has to lay out again. */
  onChange: () => void;
  scope: MountScope;
  /** Tick period; injected by tests that drive `tick` themselves. */
  tickMs?: number;
}

export interface RecentNoteCardsHandle {
  /** The cards to place right now, in document order. */
  cards: () => NoteCard[];
  /** Re-read the tinted blocks and re-age every card. */
  tick: () => void;
  destroy: () => void;
}

interface Live {
  card: HTMLElement;
  anchor: Element;
  /** The age text currently shown. */
  shown: string;
  /** When the outgoing crossfade layer may be dropped. */
  dropAt: number | null;
}

function buildCard(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'balloon margin-note';
  return el;
}

function line(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'mn-line';
  s.textContent = text;
  return s;
}

/**
 * Swap a card's text with a crossfade: the standing line becomes the
 * outgoing layer, the new one is added under it and rises. Both layers are
 * in the DOM together for the length of the fade, which is what a test reads
 * to tell a crossfade from a jump.
 */
export function crossfadeTo(card: HTMLElement, text: string): void {
  const current = card.querySelector<HTMLElement>('.mn-line:not(.is-out)');
  if (!current) {
    card.appendChild(line(text));
    return;
  }
  if (current.textContent === text) return;
  current.classList.add('is-out');
  const next = line(text);
  next.classList.add('is-in');
  card.appendChild(next);
  // Let the class land in the cascade before it is removed, so the property
  // actually transitions rather than starting at its end value.
  requestAnimationFrame?.(() => next.classList.remove('is-in'));
}

export function mountRecentNoteCards(opts: RecentNoteCardsOpts): RecentNoteCardsHandle {
  const now = () => (opts.now ?? Date.now)();
  const agent = () => opts.agentName?.() ?? 'Notes';
  const live = new Map<string, Live>();
  let order: string[] = [];

  /** Every tinted block, keyed by arrival instant plus its rank among the
   *  blocks that arrived at the same one — the DOM node itself cannot be the
   *  key, because a re-band rebuilds it. */
  function blocks(): Array<{ key: string; el: Element; at: number }> {
    const out: Array<{ key: string; el: Element; at: number }> = [];
    const seen = new Map<number, number>();
    for (const el of opts.prose.querySelectorAll('.recent-note[data-at]')) {
      const at = Number(el.getAttribute('data-at'));
      if (!Number.isFinite(at)) continue;
      const rank = seen.get(at) ?? 0;
      seen.set(at, rank + 1);
      out.push({ key: `${at}#${rank}`, el, at });
    }
    return out;
  }

  function tick(): void {
    if (opts.scope.disposed) return;
    const t = now();
    const wanted = opts.visible() ? blocks() : [];
    const keys: string[] = [];
    let changed = false;
    for (const b of wanted) {
      const age = t - b.at;
      if (age >= NOTE_CARD_MS) continue;
      keys.push(b.key);
      let entry = live.get(b.key);
      if (!entry) {
        const card = buildCard();
        entry = { card, anchor: b.el, shown: '', dropAt: null };
        live.set(b.key, entry);
        changed = true;
      }
      entry.anchor = b.el;
      const text = noteCardText(agent(), age);
      if (text !== entry.shown) {
        crossfadeTo(entry.card, text);
        entry.shown = text;
        entry.dropAt = t + NOTE_CROSSFADE_MS;
      }
      if (entry.dropAt !== null && t >= entry.dropAt) {
        for (const gone of entry.card.querySelectorAll('.mn-line.is-out')) gone.remove();
        entry.dropAt = null;
      }
      entry.card.style.opacity = noteCardOpacity(age).toFixed(3);
    }
    for (const [key, entry] of Array.from(live)) {
      if (keys.includes(key)) continue;
      entry.card.remove();
      live.delete(key);
      changed = true;
    }
    if (changed || keys.join('|') !== order.join('|')) {
      order = keys;
      opts.onChange();
    }
  }

  const period = opts.tickMs ?? 1000;
  const timer = period > 0 ? setInterval(tick, period) : null;
  opts.scope.onCleanup(() => {
    if (timer !== null) clearInterval(timer);
    for (const entry of live.values()) entry.card.remove();
    live.clear();
  });
  tick();

  return {
    cards: () =>
      order.flatMap((key) => {
        const entry = live.get(key);
        return entry ? [{ key, el: entry.card, anchor: entry.anchor }] : [];
      }),
    tick,
    destroy: () => {
      if (timer !== null) clearInterval(timer);
      for (const entry of live.values()) entry.card.remove();
      live.clear();
    },
  };
}
