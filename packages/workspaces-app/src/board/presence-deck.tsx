/**
 * The presence strip as design F, "Deck into list" (Bryan approved the mock
 * on 2026-11-15: "Looks right — F").
 *
 * Closed, the strip is one button: a deck of overlapping circles, full size
 * for the people and agents on the reader's page and small for the rest of
 * the workspace. Hovering it with a mouse, or tapping it, opens a list below
 * it in two groups, "Here with you · <page>" and "Elsewhere in <workspace>",
 * and each circle slides from its place in the deck to its row. A row says
 * where that participant is and has a Follow button; tapping the row opens
 * their card (Go there / Follow, `presence-card.tsx`), and holding it
 * follows, as holding a circle always has. While the reader follows
 * somebody, the follow bar says so.
 *
 * Every row and every deck circle is keyed on the participant, so a repaint
 * (an awareness update, an agent refresh, the 30s tick) keeps the node the
 * reader is pressing.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PresenceChip } from './board-presence-model.ts';
import { FollowBar, PresenceCard } from './presence-card.tsx';

export interface PresenceHandlers {
  /** Go to where they are, once. */
  onTap: (chip: PresenceChip) => void;
  /** Follow them, or stop following them. */
  onLongPress: (chip: PresenceChip) => void;
}

/** How long a press must be held before it follows rather than jumps.
 *  Exported so a driven test holds the press the board's own threshold asks
 *  for, rather than a number copied out of here that can drift from it. */
export const LONG_PRESS_MS = 550;

/**
 * How a circle draws. The classic face paints a span itself; the Web Awesome
 * face (`presence-island-wa.tsx`) puts a `<wa-avatar>` inside it and is
 * loaded only on a board the collab core serves.
 */
export interface PresenceFace {
  /** The class every circle carries. */
  base: string;
  /** The circle's own inline style, if the face paints the circle. */
  style?: (chip: PresenceChip) => JSX.CSSProperties;
  /** What sits inside one person's or agent's circle. */
  circle: (chip: PresenceChip) => ComponentChildren;
}

/** The deck shows at most this many circles; the list names everyone. Four
 *  overlapping circles are 88px, which leaves the title room at 430px. */
const DECK_MAX = 4;
/** How long a circle takes to slide between the deck and its row. */
const FLIP_MS = 420;
/** A mouse leaving the strip closes an unpinned list after this grace, so a
 *  pointer crossing the gap between the deck and the list does not close it. */
const LEAVE_MS = 220;

/** A press: a tap calls `onTap`, a hold calls `onHold` and swallows the tap.
 *  The press has TWO endings — pointercancel is the common one on mobile —
 *  and both must disarm the timer or one scroll wedges the strip. */
export function usePress(onTap: () => void, onHold: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // A press outliving its row would follow somebody who has left the strip.
  useEffect(() => disarm, []);
  return {
    onPointerDown: () => {
      held.current = false;
      disarm();
      timer.current = setTimeout(() => {
        held.current = true;
        onHold();
      }, LONG_PRESS_MS);
    },
    onPointerUp: disarm,
    onPointerCancel: disarm,
    onPointerLeave: disarm,
    onClick: () => {
      if (!held.current) onTap();
    },
  };
}

/** How many names the deck spells out beside its circles on a wide screen. */
const NAMED = 2;

/** The words to the left of the deck: the first names of whoever leads it, and how
 *  many more there are. "Bob, Saltmarsh +2". The list names everyone. */
export function deckNames(chips: PresenceChip[]): string {
  const names = chips.slice(0, NAMED).map((c) => c.label.trim().split(/\s+/)[0] ?? c.label);
  const more = chips.length - names.length;
  return `${names.join(', ')}${more > 0 ? ` +${more}` : ''}`;
}

function circleClass(face: PresenceFace, chip: PresenceChip, followed: boolean): string {
  return `${face.base} board-presence-${chip.kind}${chip.state ? ` board-presence-${chip.state}` : ''} ${
    chip.here ? 'board-presence-here' : 'board-presence-away'
  }${followed ? ' board-following' : ''}`;
}

function Circle(props: { chip: PresenceChip; face: PresenceFace; followed: boolean }) {
  const { chip, face, followed } = props;
  return (
    <span
      class={circleClass(face, chip, followed)}
      data-key={chip.key}
      aria-hidden="true"
      style={face.style?.(chip)}
    >
      {face.circle(chip)}
    </span>
  );
}

function Row(props: {
  chip: PresenceChip;
  face: PresenceFace;
  followed: boolean;
  handlers: PresenceHandlers;
  close: () => void;
  /** Open this participant's card. */
  open: () => void;
}) {
  const { chip, face, followed, handlers, close, open } = props;
  const press = usePress(
    () => {
      close();
      open();
    },
    () => {
      close();
      handlers.onLongPress(chip);
    },
  );
  // The words the row already shows, not the chip's own title: that one
  // names a doc by its id.
  const where = chip.line ?? chip.where;
  const title = `${chip.label} · ${where}${followed ? ' · following' : ''}`;
  return (
    <div class="board-presence-row" data-key={chip.key}>
      <button type="button" class="board-presence-who" title={title} {...press}>
        <Circle chip={chip} face={face} followed={followed} />
        <span class="board-presence-row-text">
          <b>{chip.label}</b>
          <small>{chip.line ?? chip.where}</small>
        </span>
      </button>
      <button
        type="button"
        class="board-presence-follow"
        aria-label={followed ? `Stop following ${chip.label}` : `Follow ${chip.label}`}
        onClick={() => {
          close();
          handlers.onLongPress(chip);
        }}
      >
        {followed ? 'Stop' : 'Follow'}
      </button>
    </div>
  );
}

/** Where the list opens: under the deck, its right edge on the deck's, kept
 *  on screen. At 1100px and below it spans the window, 8px in from each side. */
function placeList(deck: HTMLElement, list: HTMLElement): void {
  const r = deck.getBoundingClientRect();
  const win = deck.ownerDocument.defaultView;
  const width = win?.innerWidth ?? 0;
  list.style.top = `${Math.round(r.bottom + 8)}px`;
  if (width <= 1100) {
    list.style.left = '8px';
    list.style.right = '8px';
    return;
  }
  list.style.right = '';
  const w = list.offsetWidth;
  list.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, width - w - 8)))}px`;
}

/** Slide each row's circle from (or back to) its place in the deck. False
 *  when nothing moves: reduced motion, or no layout to measure. */
function flip(deck: HTMLElement, list: HTMLElement, open: boolean): boolean {
  const win = deck.ownerDocument.defaultView;
  if (!win || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const from = new Map<string, DOMRect>();
  for (const el of deck.querySelectorAll<HTMLElement>('[data-key]')) {
    from.set(el.dataset.key ?? '', el.getBoundingClientRect());
  }
  const ease = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.2,1)`;
  const moves: Array<[HTMLElement, string]> = [];
  for (const row of list.querySelectorAll<HTMLElement>('.board-presence-row')) {
    const a = from.get(row.dataset.key ?? '');
    const c = row.querySelector<HTMLElement>('[data-key]');
    if (!a || !c) continue;
    const b = c.getBoundingClientRect();
    if (!b.width) continue;
    moves.push([
      c,
      `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})`,
    ]);
  }
  for (const [c, to] of moves) {
    c.style.transformOrigin = '0 0';
    c.style.transition = open ? 'none' : ease;
    c.style.transform = to;
  }
  if (moves.length === 0) return false;
  if (!open) return true;
  list.getBoundingClientRect();
  win.requestAnimationFrame(() => {
    for (const [c] of moves) {
      c.style.transition = ease;
      c.style.transform = '';
    }
  });
  return true;
}

export function PresenceDeck(props: {
  chips: PresenceChip[];
  followedKey: string | null;
  /** The reader's page, for the first group's heading. */
  page?: string;
  /** The workspace's name, for the second group's heading. */
  app?: string;
  handlers: PresenceHandlers;
  face: PresenceFace;
}) {
  const { followedKey, handlers, face } = props;
  // The followed participant leads their group, so their ring is always
  // in the deck.
  const others = props.chips
    .filter((c) => !c.self)
    .sort((a, b) => Number(b.key === followedKey) - Number(a.key === followedKey));
  const here = others.filter((c) => c.here);
  const away = others.filter((c) => !c.here);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const pinned = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef('mouse');
  const root = useRef<HTMLDivElement>(null);
  /** The card and the bar: beside the wrapper, not in it, so a mouse passing
   *  over the bar does not count as hovering the deck and drop the list over
   *  it. Still part of the strip for a tap or focus outside. */
  const floats = useRef<HTMLDivElement>(null);
  const inStrip = (n: Node) => !!(root.current?.contains(n) || floats.current?.contains(n));
  const deck = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLElement>(null);
  const followedChip = others.find((c) => c.key === followedKey);
  // Whose card is open, by participant, so a repaint keeps it open on them.
  const [cardKey, setCardKey] = useState<string | null>(null);
  const cardChip = cardKey ? others.find((c) => c.key === cardKey) : undefined;

  // Mirrors `open` for the listeners below, which outlive the render that
  // made them.
  const isOpen = useRef(false);
  isOpen.current = open;
  /** Close the list; it stays drawn while the circles slide back. */
  const close = () => {
    pinned.current = false;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (!isOpen.current) return;
    isOpen.current = false;
    setClosing(true);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!deck.current || !list.current) return;
    if (open) {
      // Open: place the list, then slide the circles out of the deck. The
      // list replaces any card that was showing.
      setCardKey(null);
      setClosing(false);
      placeList(deck.current, list.current);
      flip(deck.current, list.current, true);
      return;
    }
    if (!flip(deck.current, list.current, false)) {
      setClosing(false);
      return;
    }
    closeTimer.current = setTimeout(() => setClosing(false), FLIP_MS);
  }, [open]);

  // A tap anywhere else, or Escape, closes it; a resize places it again.
  // A layout effect, so the listeners are there before the next input.
  const listening = open || cardChip !== undefined;
  useLayoutEffect(() => {
    if (!listening) return;
    const doc = root.current?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const outside = (ev: Event) => {
      if (ev.target instanceof Node && inStrip(ev.target)) return;
      close();
      setCardKey(null);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      close();
      setCardKey(null);
      deck.current?.focus();
    };
    // Keyboard focus leaving the strip closes it, as a tap outside does.
    const blur = (ev: FocusEvent) => {
      const to = ev.relatedTarget;
      if (to instanceof Node && inStrip(to)) return;
      if (to === null) return;
      close();
      setCardKey(null);
    };
    const resize = () => {
      if (deck.current && list.current) placeList(deck.current, list.current);
    };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', key);
    const parts = [root.current, floats.current];
    for (const el of parts) el?.addEventListener('focusout', blur);
    win.addEventListener('resize', resize);
    return () => {
      for (const el of parts) el?.removeEventListener('focusout', blur);
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', key);
      win.removeEventListener('resize', resize);
    };
  }, [listening]);

  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Nobody else in the workspace: the strip is hidden, and so is the list.
  if (others.length === 0) return null;

  const deckChips = [...here, ...away].slice(0, DECK_MAX);
  const summary = `${here.length} here with you, ${away.length} elsewhere${
    followedChip ? `, following ${followedChip.label}` : ''
  }`;
  const rows = (group: PresenceChip[]) =>
    group.map((chip) => (
      <Row
        key={chip.key}
        chip={chip}
        face={face}
        followed={chip.key === followedKey}
        handlers={handlers}
        close={close}
        open={() => setCardKey(chip.key)}
      />
    ));
  const shown = open || closing;
  return (
    <>
      <div
        ref={root}
        class={`board-presence-f${open ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
        onPointerEnter={(ev) => {
          if (ev.pointerType !== 'mouse') return;
          if (leaveTimer.current) clearTimeout(leaveTimer.current);
          if (!open) setOpen(true);
        }}
        onPointerLeave={(ev) => {
          if (ev.pointerType !== 'mouse' || pinned.current) return;
          if (leaveTimer.current) clearTimeout(leaveTimer.current);
          leaveTimer.current = setTimeout(() => {
            if (!pinned.current) close();
          }, LEAVE_MS);
        }}
      >
        <button
          ref={deck}
          type="button"
          class="board-presence-deck"
          aria-haspopup="true"
          aria-expanded={open ? 'true' : 'false'}
          aria-label={summary}
          title={summary.replace(', ', ' · ')}
          onPointerDown={(ev) => {
            lastPointer.current = ev.pointerType || 'mouse';
          }}
          onClick={() => {
            // A mouse already opened it by hovering; the click keeps it open.
            if (lastPointer.current === 'mouse' && open && !pinned.current) {
              pinned.current = true;
              return;
            }
            if (open) close();
            else {
              pinned.current = true;
              setOpen(true);
            }
          }}
        >
          {deckChips.map((chip) => (
            <Circle key={chip.key} chip={chip} face={face} followed={chip.key === followedKey} />
          ))}
          {/* Hidden at 1100px and below, where the deck has no room for it.
              For the eye only: the button's aria-label is its name. */}
          <span class="board-presence-names" aria-hidden="true">
            {deckNames([...here, ...away])}
          </span>
        </button>
        {shown && (
          <section
            ref={list}
            class="board-presence-list"
            aria-label={`Who is in ${props.app ?? 'this workspace'}`}
          >
            <span class="board-presence-group">
              {props.page ? `Here with you · ${props.page}` : 'Here with you'}
            </span>
            {here.length > 0 ? rows(here) : <div class="board-presence-only">Only you</div>}
            {away.length > 0 && (
              <span class="board-presence-group">
                {`Elsewhere in ${props.app ?? 'this workspace'}`}
              </span>
            )}
            {rows(away)}
          </section>
        )}
      </div>
      <div ref={floats} class="board-presence-floats">
        {cardChip && (
          <PresenceCard
            chip={cardChip}
            face={face}
            followed={cardChip.key === followedKey}
            app={props.app}
            anchor={deck.current}
            onGo={() => {
              setCardKey(null);
              handlers.onTap(cardChip);
            }}
            onFollow={() => {
              setCardKey(null);
              handlers.onLongPress(cardChip);
            }}
          />
        )}
        {followedChip && (
          <FollowBar
            chip={followedChip}
            face={face}
            onStop={() => handlers.onLongPress(followedChip)}
          />
        )}
      </div>
    </>
  );
}
