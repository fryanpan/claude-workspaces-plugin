/**
 * The presence strip as a Preact island — who is here (the top-right deck,
 * `presence-deck.tsx`) and the drift notices in the settings panel, both of which the
 * vanilla `renderPresence` used to build by wiping its container and
 * rebuilding every node.
 *
 * This is the pane the migration was actually about. A presence row is a
 * live control with a 550ms long-press on it, and the strip repaints on every
 * awareness update, every SSE agent refresh and a 30s tick — so a repaint
 * routinely landed in the middle of a press. Rebuilding the node mid-press
 * left the timer armed against a button the reader was no longer touching:
 * the `pointerup` that should have cancelled the follow arrived on a REPLACED
 * node, whose own disarm closure knew nothing about the running timer. The
 * tap that was meant to press the button destroyed it.
 *
 * Keyed rows fix that at the root. `PresenceChip.key` is the participant
 * (`p-<name>` / `a-<agentId>`), not the array index and not the Yjs
 * `clientId` — `clientId` is minted per connection, so it changes on every
 * reload and cannot name a person; it is only ever used to fold one person's
 * several tabs into one row (`foldTabs` in board-presence-model). An unchanged
 * participant therefore keeps the IDENTICAL DOM node across a signal update,
 * and the press it is holding survives with it.
 *
 * The bridge is one-directional, as in the Home review island: the vanilla
 * `renderPresenceRegion` still owns awareness, the agent list and the drift
 * readings, and writes them into `presenceData` / `driftData`. The island
 * only reads. Handlers are bound once at mount.
 */
import { signal } from '@preact/signals';
import { type ComponentChildren, Fragment, render } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import {
  type DriftNotice,
  type PresenceChip,
  initialsOf,
  presenceHue,
} from './board-presence-model.ts';
import {
  PresenceDeck,
  type PresenceFace,
  type PresenceHandlers,
  usePress,
} from './presence-deck.tsx';

export type { PresenceFace, PresenceHandlers } from './presence-deck.tsx';
export { LONG_PRESS_MS } from './presence-deck.tsx';

/** Today's circle: a filled span with the initials in it. */
export const CLASSIC_FACE: PresenceFace = {
  base: 'board-presence-circle',
  style: (chip) => ({ background: `hsl(${presenceHue(chip.label)}, 45%, 45%)` }),
  circle: (chip) => <span class="board-presence-initials">{initialsOf(chip.label)}</span>,
};

export interface PresenceData {
  chips: PresenceChip[];
  followedKey: string | null;
  /** The reader's page, as the strip's list heads its first group. */
  page?: string;
  /** The workspace's name, as the list heads its second group. */
  app?: string;
}

/** Who is here. The one write target the vanilla loader has for the strip. */
export const presenceData = signal<PresenceData>({ chips: [], followedKey: null });

/**
 * What is running where. A LIST, because "what is running where" has two
 * independent answers: the agents' plugin bundles and the browser's own
 * client. They fail separately and are fixed separately, so neither may hide
 * the other — and a slot may be empty, which is why the nulls travel rather
 * than being filtered upstream (the slot is what keys the note).
 */
export const driftData = signal<ReadonlyArray<DriftNotice | null | undefined>>([]);

/**
 * One person or agent in the long form: the name and the surface spelled
 * out. A component rather than inline JSX because the press state has to live
 * somewhere that survives a re-render.
 */
function PresenceChipButton(props: {
  chip: PresenceChip;
  followed: boolean;
  handlers: PresenceHandlers;
}) {
  const { chip, followed, handlers } = props;
  const press = usePress(
    () => handlers.onTap(chip),
    () => handlers.onLongPress(chip),
  );
  return (
    <button
      type="button"
      class={`board-presence-chip board-presence-${chip.kind}${chip.state ? ` board-presence-${chip.state}` : ''}${
        followed ? ' board-following' : ''
      }`}
      title={followed ? `${chip.title} · following — long-press to stop` : chip.title}
      {...press}
    >
      <span class="board-presence-name">{chip.label}</span>
      <span class="board-presence-where">{chip.where}</span>
    </button>
  );
}

/**
 * An empty region must not sit in the header taking a gap's worth of room, so
 * the `hidden` class is toggled on the HOST rather than rendered — the host
 * is the flex container the shell built and the CSS targets, and the island
 * only ever owns its wrapper's children. A class is not a child, so this
 * writes nothing Preact believes it owns.
 */
function useHostVisibility(host: HTMLElement, empty: boolean): void {
  useLayoutEffect(() => {
    host.classList.toggle('hidden', empty);
  }, [host, empty]);
}

function PresenceStrip(props: {
  host: HTMLElement;
  handlers: PresenceHandlers;
  compact: boolean;
  face: PresenceFace;
}) {
  const { chips, followedKey, page, app } = presenceData.value;
  // The reader is never drawn, so a strip of only the reader is empty.
  useHostVisibility(props.host, !chips.some((c) => !c.self));
  if (props.compact) {
    return (
      <PresenceDeck
        chips={chips}
        followedKey={followedKey}
        page={page}
        app={app}
        handlers={props.handlers}
        face={props.face}
      />
    );
  }
  return (
    <Fragment>
      {chips.map((chip) => (
        <PresenceChipButton
          key={chip.key}
          chip={chip}
          followed={followedKey === chip.key}
          handlers={props.handlers}
        />
      ))}
    </Fragment>
  );
}

/** The reading each slot of `driftData` carries, in the order the loader
 *  writes them. A notice's identity is WHICH READING it is, not where it
 *  landed in a filtered list — so a fixed plugin going quiet leaves the client
 *  notice beside it as the same node. */
const DRIFT_SLOTS = ['plugin', 'client'] as const;
const driftSlotId = (slot: number): string => DRIFT_SLOTS[slot] ?? `slot-${slot}`;

function DriftStrip(props: { host: HTMLElement }) {
  const notes = driftData.value
    .map((notice, slot) => ({ id: driftSlotId(slot), notice }))
    .filter((s): s is { id: string; notice: DriftNotice } => Boolean(s.notice));
  useHostVisibility(props.host, notes.length === 0);
  return (
    <Fragment>
      {notes.map(({ id, notice }) => (
        <div
          key={id}
          // A coverage line is always on the board, so it gets the quiet
          // treatment. Styling it like the alarm would train people to skim
          // past the alarm.
          class={notice.kind === 'coverage' ? 'board-drift board-drift-quiet' : 'board-drift'}
        >
          <span class="board-drift-head">{notice.headline}</span>
          <span class="board-drift-who">{notice.detail}</span>
          <span class="board-drift-fix">{notice.fix}</span>
        </div>
      ))}
    </Fragment>
  );
}

/** The island contract, as the probe proved it: the wrapper — not the host —
 *  is Preact's container, disposal is render(null, el), and no vanilla code
 *  may replaceChildren/innerHTML a container holding a live island. The
 *  wrapper is `display: contents` so the strip's buttons stay direct flex
 *  items of the host, which is what the `.board-presence` layout is written
 *  against. */
function mountInto(host: HTMLElement, name: string, tree: ComponentChildren): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', name);
  host.appendChild(el);
  render(tree, el);
  return () => {
    render(null, el);
    el.remove();
  };
}

/**
 * Who is here, into a wrapper appended to `host`. `compact` is the top-right
 * deck that opens into the two-group list (design F, Bryan 2026-11-15); the
 * long form is the original chip with the name and the surface spelled out.
 */
export function mountPresenceIsland(
  host: HTMLElement,
  handlers: PresenceHandlers,
  opts: { compact?: boolean; face?: PresenceFace } = {},
): () => void {
  return mountInto(
    host,
    'presence',
    <PresenceStrip
      host={host}
      handlers={handlers}
      compact={opts.compact ?? false}
      face={opts.face ?? CLASSIC_FACE}
    />,
  );
}

/** What is running where, into a wrapper appended to `host`. */
export function mountDriftIsland(host: HTMLElement): () => void {
  return mountInto(host, 'presence-drift', <DriftStrip host={host} />);
}
