/**
 * The two surfaces design F adds beside the deck (the approved mock,
 * 2026-11-15): the card a tap on a person or agent opens, and the bar that
 * says who the reader is following.
 *
 * The card says who it is, where they are (here with you, or elsewhere in the
 * workspace, and what they are reading or pointing at), and offers the two
 * things a reader can do: go there once, or follow. On a wide screen it hangs
 * under the deck; at 1100px and below it is a bottom sheet (`styles.css`).
 *
 * The bar is the steady sign of a follow, because a follow takes the reader's
 * navigation over and must never run unnoticed. It floats over the page, so
 * starting or stopping a follow moves nothing on it: at the bottom on a wide
 * screen, under the header on a phone.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PresenceChip } from './board-presence-model.ts';
import type { PresenceFace } from './presence-deck.tsx';

/** A circle in the card or the bar: the face's own paint, never keyed for
 *  the deck's slide (no `data-key`). */
function FaceCircle(props: { chip: PresenceChip; face: PresenceFace; extra: string }) {
  const { chip, face, extra } = props;
  return (
    <span
      class={`${face.base} board-presence-${chip.kind} ${extra}`}
      aria-hidden="true"
      style={face.style?.(chip)}
    >
      {face.circle(chip)}
    </span>
  );
}

/** Under the anchor, its right edge on the anchor's, kept on screen. Only on a
 *  wide screen: below 1100px the stylesheet makes the card a bottom sheet. */
function placeCard(anchor: HTMLElement, card: HTMLElement): void {
  const win = card.ownerDocument.defaultView;
  const width = win?.innerWidth ?? 0;
  if (width <= 1100) {
    card.style.top = '';
    card.style.left = '';
    return;
  }
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth;
  card.style.top = `${Math.round(r.bottom + 8)}px`;
  card.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, width - w - 8)))}px`;
}

export function PresenceCard(props: {
  chip: PresenceChip;
  face: PresenceFace;
  followed: boolean;
  /** The workspace's name, for "Elsewhere in …". */
  app?: string;
  /** What the card hangs under on a wide screen. */
  anchor: HTMLElement | null;
  onGo: () => void;
  onFollow: () => void;
}) {
  const { chip, face, followed } = props;
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (props.anchor && card.current) placeCard(props.anchor, card.current);
  });
  const agent = chip.kind === 'agent';
  return (
    <section ref={card} class="board-presence-card" aria-label={chip.label} data-key={chip.key}>
      <div class="board-presence-card-head">
        <FaceCircle
          chip={chip}
          face={face}
          extra={`${chip.here ? 'board-presence-here' : 'board-presence-away'}${
            followed ? ' board-following' : ''
          }`}
        />
        <span>
          <b class="board-presence-card-name">{chip.label}</b>
          <small class="board-presence-card-kind">{agent ? 'Agent' : 'Person'}</small>
        </span>
      </div>
      <p class="board-presence-card-where">
        <span class="board-presence-card-tag">
          {chip.here ? 'Here with you' : `Elsewhere in ${props.app ?? 'this workspace'}`}
        </span>
        {chip.place ?? chip.line ?? chip.where}
      </p>
      <div class="board-presence-card-actions">
        <button type="button" class="board-presence-act" data-act="go" onClick={props.onGo}>
          {chip.here ? 'Show me' : 'Go there'}
        </button>
        <button
          type="button"
          class="board-presence-act board-presence-act-primary"
          data-act="follow"
          onClick={props.onFollow}
        >
          {followed ? 'Stop following' : 'Follow'}
        </button>
      </div>
      <p class="board-presence-card-hint">
        {agent
          ? 'Follow keeps you on what it points at, on any page.'
          : 'Follow keeps you on their page as they move.'}{' '}
        Holding a row follows too.
      </p>
    </section>
  );
}

export function FollowBar(props: { chip: PresenceChip; face: PresenceFace; onStop: () => void }) {
  const { chip, face } = props;
  return (
    <section class="board-follow-bar" aria-label={`Following ${chip.label}`} data-key={chip.key}>
      <FaceCircle chip={chip} face={face} extra="board-presence-here" />
      <span class="board-follow-text">
        <span>
          Following <b>{chip.label}</b>
        </span>
        <small>{chip.page ?? chip.line ?? chip.where}</small>
      </span>
      <button
        type="button"
        class="board-presence-act"
        aria-label={`Stop following ${chip.label}`}
        onClick={props.onStop}
      >
        Stop
      </button>
    </section>
  );
}
