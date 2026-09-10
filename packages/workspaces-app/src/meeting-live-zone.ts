/**
 * The provisional zone: the live transcript rendered at the END of the doc,
 * where the notes it will become are about to land — instead of only in the
 * strip under the top bar, a viewport away from the writing.
 *
 * WHAT IT IS NOT. The transcript never enters the document — that invariant
 * belongs to the meeting pipeline (the notes agent writes the doc, from the
 * durable transcript, at pauses). This zone is chrome APPENDED AFTER the
 * editor's content element: plain DOM, no Yjs, gone without trace when the
 * meeting ends. Nothing here can leak a provisional word into the record.
 *
 * WHAT IT SHOWS: an unframed block, labelled "Live transcript" in its top
 * right corner, holding ONE flowing run of text. The engine hands words over
 * in turns of a few words every few seconds, and a turn is the engine's
 * unit, not the reader's (owner, 2026-09-01: "engine turns have no meaning
 * or value to the viewer, I expect a stream of text"). So turns are inline
 * spans joined by a space — no per-turn time stamp, no per-turn block — and
 * the only line breaks are the ones the engine itself put in a turn's text.
 * No status lights, no blinking dots; the one animated thing in the stream
 * is the caret on the words still being spoken.
 *
 * THE SETTLE (approved settle mock, round 2). When a tick fires the
 * settled words split off into a block of their own, so their height can be
 * collapsed later. That block carries no box, no label and no type change,
 * so its words land on the very pixels they were already on, and whatever is
 * still being said keeps streaming below it. When the note lands, those
 * words FADE WHERE THEY SIT — opacity alone, so not one word around them
 * moves — and only once they are gone does the slot collapse and ease the
 * stream up into the space. Two beats, never overlapping: the complaint was
 * drift, and every simultaneous movement is a source of it. The settle wash
 * on the freshly written note (settle-wash.ts) carries the eye upward.
 *
 * Nothing is drawn in the chunk's place while it composes — no card, no
 * "Writing this into the notes above…" line, no spinner. Both of those took
 * up space and shifted the words they wrapped (owner, 2026-09-05: "just fade
 * the text chunk out when it's written up into the text").
 *
 * Speaker pills follow the notes rule, not the strip's: only once a second
 * voice has actually been heard, and then only where the voice CHANGES — a
 * pill on every few words of one speaker is the engine's turn boundary
 * showing through again. A solo huddle's own name is noise (owner's call,
 * 2026-08-31). The pill is `meeting-speaker-pill.ts`'s, and it is WHERE A
 * VOICE IS NAMED: the strip's tappable one is never on screen while this zone
 * exists, so these were the only pills the iPad showed and they were inert.
 */

import { createStreamHold } from './meeting-live-hold.ts';
import { speakerPill } from './meeting-speaker-pill.ts';

/** One transcript turn as the zone tracks it. */
export interface LiveZoneTurn {
  turn: number;
  text: string;
  final: boolean;
  /** The engine's label for the voice ("A"); display goes through names. */
  speaker?: string;
}

/** A `notes_progress` frame, already parsed. */
export interface LiveZoneProgress {
  tick: number;
  phase: 'composing' | 'written' | 'empty' | 'failed';
  turns: readonly number[];
}

export interface MeetingLiveZone {
  /** A meeting is live. `startedAtMs` is the meeting clock's anchor; the
   *  zone no longer stamps turns with it, and takes it so a caller that has
   *  it need not change. */
  begin(startedAtMs: number): void;
  onTurn(t: LiveZoneTurn): void;
  onProgress(e: LiveZoneProgress): void;
  /** The strip's label→name map, re-sent whenever a voice is (re)named. */
  setNames(names: Readonly<Record<string, string>>): void;
  /**
   * Fallback for meetings WITHOUT progress frames (a bot's words arrive over
   * the doc stream, and nothing tells this zone what a tick did): notes just
   * landed remotely, so every settled line has been written — settle them,
   * keep the one still being spoken.
   *
   * It settles rather than deletes, so the bot path leaves by the same two
   * beats every other path does, and it is INERT once a meeting has reported
   * a tick: a doc insert and a `written` frame are the same event arriving
   * twice, and this one carries no turn ids, so running both let a note
   * landing a beat early wipe the very chunk the frame was about to fade.
   */
  clearSettled(): void;
  /** The meeting ended, however it ended: hide and forget everything. */
  end(): void;
  /** Whether a live meeting currently owns the zone. */
  active(): boolean;
  /**
   * Whether the settle wash should still fire (settle-wash.ts's `isLive`):
   * during the meeting, and for a short grace after it ends — the end tick's
   * note is composed asynchronously and lands seconds after `stopped`.
   */
  washActive(): boolean;
  destroy(): void;
}

/** How long after a meeting ends its last note may still earn the wash. */
export const WASH_GRACE_MS = 30_000;

/**
 * The settle's two beats. The chunk fades where it sits, and only then does
 * its slot collapse.
 *
 * doc.css owns the same two numbers as `--lz-fade-ms` / `--lz-collapse-ms`,
 * because the transitions are CSS; these are what the JS waits for between
 * beats. live-zone-css.test.ts fails if the pair ever disagrees.
 */
export const FADE_MS = 260;
export const COLLAPSE_MS = 440;

/**
 * How long the settled chunk holds — height pinned, fully visible — after
 * its note is reported written, before the fade starts.
 *
 * The `written` frame and the note's own Yjs update reach the client over
 * two different channels, so the note can land a beat AFTER the frame.
 * Fading on the frame let the arriving note push the fading words down the
 * page: 28 measured pixels of drift in the mock, and the second source of
 * the movement this change exists to remove. The note lands, the page
 * settles, then the fade starts. One motion at a time.
 */
export const NOTE_LAND_MS = 420;

interface ZoneTurn {
  turn: number;
  text: string;
  final: boolean;
  speaker?: string;
  /** Set while a tick that carries this turn is composing. */
  composing: boolean;
  /** Set while an in-place settle is fading this turn out of the stream. */
  fading?: boolean;
}

/** How far below the pane's visible edge the zone's bottom may sit and
 *  still count as "in view" — a scroll that leaves it within this is not a
 *  scroll away from it. */
export const FOLLOW_SLACK_PX = 48;
/** Breathing room kept under the zone when it is scrolled into view. */
const FOLLOW_PAD_PX = 12;

export function createMeetingLiveZone(opts: {
  /** Rendered as `parent`'s last child — after the editor's content. */
  parent: HTMLElement;
  /**
   * The editor's content element. The zone copies its width exactly: in the
   * balloon-margin grid the prose shrink-wraps to its widest line (auto
   * margins in a grid cell), a width no stylesheet rule can coincide with.
   */
  prose?: HTMLElement;
  /** The scroll pane the zone is kept in view within. Defaults to `parent`. */
  scroller?: HTMLElement;
  now?: () => number;
  /**
   * Whether the viewer asked for reduced motion. Reads the media query by
   * default; injected by tests, which have no media engine to read.
   */
  reducedMotion?: () => boolean;
  /** Name this voice — the strip's verb; absent, the pill is a plain label. */
  nameSpeaker?: (label: string) => void;
}): MeetingLiveZone {
  const now = opts.now ?? (() => Date.now());
  const scroller = opts.scroller ?? opts.parent;
  const reducedMotion =
    opts.reducedMotion ??
    (() =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const root = document.createElement('div');
  root.className = 'live-zone';
  root.hidden = true;
  root.setAttribute('aria-live', 'off');

  const head = document.createElement('div');
  head.className = 'lz-head';
  const label = document.createElement('span');
  label.className = 'lz-label';
  label.textContent = 'Live transcript';
  head.append(label);

  // Holds the settled chunks: the one a tick is composing, plus any still
  // fading out behind it. A container, not a surface — the sheet gives it
  // nothing, so it adds no box and no space of its own.
  const chunkHost = document.createElement('div');
  chunkHost.className = 'lz-chunks';

  const lines = document.createElement('div');
  lines.className = 'lz-lines';

  root.append(head, chunkHost, lines);
  opts.parent.append(root);

  let live = false;
  let endedAt = 0;
  /** Whether this meeting has ever reported a tick. One that does is driven
   *  by its frames alone; see `clearSettled`. */
  let sawProgress = false;
  let names: Readonly<Record<string, string>> = {};
  const turns = new Map<number, ZoneTurn>();
  /** Voices actually heard — two of them is what turns the pills on. */
  const voices = new Set<string>();

  const ordered = (): ZoneTurn[] => [...turns.values()].sort((a, b) => a.turn - b.turn);

  /**
   * Follow mode: the zone is kept in view as it grows — the transcript is
   * what the person is watching. Off the moment they scroll it out of view
   * (a deliberate scroll up to read or edit is never fought), on again once
   * they scroll back to it. Decided from where the zone IS after each
   * scroll, so the zone's own scrolling always lands in "following".
   */
  let follow = true;

  /** Pixels the zone's bottom (plus padding) sits below the pane's visible
   *  edge; ≤ 0 means in view. Null while the zone is hidden. */
  function overflowBelow(): number | null {
    if (root.hidden) return null;
    const visibleBottom = scroller.getBoundingClientRect().top + scroller.clientHeight;
    return root.getBoundingClientRect().bottom + FOLLOW_PAD_PX - visibleBottom;
  }
  const onScroll = (): void => {
    const over = overflowBelow();
    if (over !== null) follow = over <= FOLLOW_SLACK_PX;
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  /**
   * LOAD-BEARING, and not designed: while following, the pane sits at its
   * foot, and a pane at its foot cannot keep its offset when its content
   * shrinks — the browser clamps scrollTop by exactly the loss. That clamp is
   * what holds the reader's line still through the collapse; nothing here
   * scrolls up on purpose. Anything that keeps the pane off its foot (a
   * bottom spacer, following that stops short of the end) loses the guarantee
   * with no test going red. meeting-live-hold.ts THE RESERVE is the other
   * half: a shrink BELOW the reader's line turns the same clamp into a step.
   */
  function keepInView(): void {
    if (!follow) return;
    const over = overflowBelow();
    if (over !== null && over > 0) scroller.scrollTop += over;
  }

  function matchProseWidth(): void {
    if (!opts.prose || root.hidden) return;
    const width = opts.prose.getBoundingClientRect().width;
    root.style.width = width > 0 ? `${width}px` : '';
  }
  // The prose changes size as notes land (taller, and wider when a new line
  // is the longest): re-match the width, and follow the zone down.
  const resize =
    typeof ResizeObserver === 'undefined' || !opts.prose
      ? null
      : new ResizeObserver(() => {
          matchProseWidth();
          keepInView();
        });
  if (opts.prose) resize?.observe(opts.prose);

  /**
   * One turn as an inline span. The text's own newlines — the only breaks
   * the engine ever emits — become <br>s; nothing else in a turn is a line.
   */
  function spanFor(t: ZoneTurn, prev: ZoneTurn | null): HTMLElement {
    const span = document.createElement('span');
    const cls = ['lz-turn'];
    if (!t.final) cls.push('lz-partial');
    // Only an IN-PLACE settle renders a composing turn here — the lift puts
    // them in a chunk body that already carries `lz-chunk` — so this is the
    // one path where the span itself has to wear the colour and the fade.
    if (t.composing) cls.push('lz-chunk');
    if (t.fading) cls.push('is-fading');
    span.className = cls.join(' ');
    const opens = voices.size >= 2 && t.speaker !== prev?.speaker;
    if (opens && t.speaker) span.append(speakerPill(t.speaker, names, opts.nameSpeaker));
    const parts = t.text.split('\n');
    for (const [i, part] of parts.entries()) {
      if (i > 0) span.append(document.createElement('br'));
      if (part) span.append(part);
    }
    return span;
  }

  /** The turns as one run: spans with a single space between them. */
  function runOf(ts: readonly ZoneTurn[]): Node[] {
    const out: Node[] = [];
    ts.forEach((t, i) => {
      if (i > 0) out.push(document.createTextNode(' '));
      out.push(spanFor(t, ts[i - 1] ?? null));
    });
    return out;
  }

  /** A split-off chunk: the block its words were lifted into, and the timer
   *  carrying it through the settle. */
  interface Chunk {
    slot: HTMLElement;
    body: HTMLElement;
    timer: ReturnType<typeof setTimeout> | null;
  }
  /** The chunk a tick is composing, if one is. */
  let openChunk: Chunk | null = null;
  /** Set for the length of the render a split runs through — see
   *  meeting-live-hold.ts for what it is for. */
  let splitAnchor: DOMRect | null = null;
  /** Chunks whose note has landed and that are fading / collapsing out. */
  const settling = new Set<Chunk>();

  /**
   * THE SETTLE THAT CANNOT LIFT, and why there has to be one.
   *
   * A chunk is a block ABOVE the stream, so lifting words into one only tells
   * the truth when those words are the FRONT of the stream. A tick that
   * composed nothing reports `empty`, its words go back to the stream — and
   * the server drops them from its own carry, so no later tick ever names
   * them again (meeting-notes.ts: `carry` is refilled on `failed`, not on
   * `empty`). They sit at the head of the stream for the rest of the meeting,
   * and every settle after that one composes turns with a survivor in front
   * of them.
   *
   * Lifted anyway, those words leave the middle of the run: the chunk block
   * is inserted ABOVE words that were spoken BEFORE it, and the hold — which
   * exists to put a stream back on a line the chunk's tail ends mid-way
   * through — measures a whole line of drop with nothing to indent past, so
   * it pulls the stream up ONTO the chunk. Measured in Chrome before this
   * change, at the third note-write of a meeting with one empty tick: 157.5px
   * of one line painted over another, both runs fully opaque, at 1180x820 and
   * again at 430.
   *
   * So a settle whose words are not the front of the stream does not lift
   * them. They fade WHERE THEY ARE, inside the run, on the same two beats and
   * the same colour step: nothing moves on the split frame at all, and the
   * stream closes over the gap when they go. What is lost is the eased
   * collapse — a hole in the middle of a run cannot be eased shut by a margin
   * on the block that holds it — and that is the whole of the cost.
   */
  let inPlace = false;
  /** The in-place settle's timer, so a meeting ending mid-fade takes it. */
  let inPlaceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The turns that settle is on its way to removing. */
  let inPlacePending: readonly number[] = [];

  /** Holds the stream still across a split — meeting-live-hold.ts. */
  const streamHold = createStreamHold(lines);

  /** What `lines` renders: the stream, plus — while an in-place settle runs —
   *  the fading turns still sitting in the middle of it. */
  function streamTurns(): ZoneTurn[] {
    const all = ordered();
    return inPlace ? all : all.filter((t) => !t.composing);
  }

  /**
   * Whether these turns are the front of the stream, which is the only shape
   * a chunk can hold without reordering what the reader is reading.
   */
  function liftable(leaving: readonly number[]): boolean {
    const going = new Set(leaving);
    const stream = ordered().filter((t) => !t.composing);
    return stream.slice(0, going.size).every((t) => going.has(t.turn));
  }

  /**
   * Where the words that will STILL be streaming after this split sit now.
   *
   * Not the stream's first turn: that is usually one of the ones leaving, and
   * anchoring on it holds the stream to a position its own words are about to
   * vacate. The turn to hold is the first survivor — `leaving` names who is
   * going, and everything already composing left on an earlier tick.
   *
   * Indexed against what `lines` actually renders rather than against the
   * turn list, because those two differ while an in-place settle is running.
   */
  function survivorAnchor(leaving: readonly number[]): DOMRect | null {
    const going = new Set(leaving);
    const i = streamTurns().findIndex((t) => !going.has(t.turn) && !t.composing);
    return i < 0 ? null : streamHold.rectAt(i);
  }

  function mountChunk(): Chunk {
    const slot = document.createElement('div');
    slot.className = 'lz-slot';
    const body = document.createElement('div');
    // The chunk and the stream are typographically the SAME text: `lz-chunk`
    // adds the fade and one tone of colour, nothing else — no size, no
    // weight, no box — or splitting one off would move the words it holds.
    body.className = 'lz-chunk lz-chunk-lines';
    slot.append(body);
    chunkHost.append(slot);
    return { slot, body, timer: null };
  }

  function step(c: Chunk, ms: number, fn: () => void): void {
    c.timer = setTimeout(() => {
      c.timer = null;
      fn();
    }, ms);
  }

  function discard(c: Chunk): void {
    if (c.timer !== null) clearTimeout(c.timer);
    c.timer = null;
    settling.delete(c);
    c.slot.remove();
  }

  /** Fade the chunk out where it stands, then collapse the space it held. */
  function settle(c: Chunk): void {
    settling.add(c);
    // Pin the height BEFORE anything animates: from here nothing this chunk
    // does can move a word below it, for the whole of the fade.
    c.slot.style.height = `${c.slot.getBoundingClientRect().height}px`;
    const reduced = reducedMotion();
    step(c, NOTE_LAND_MS, () => {
      c.body.classList.add('is-fading');
      step(c, FADE_MS, () => {
        // Reduced motion keeps the cross-fade and loses only the travel
        // (owner, 2026-09-05: the instant swap "was too sudden"). Less
        // movement, not none.
        if (reduced) c.slot.style.setProperty('--lz-collapse-ms', '0ms');
        c.slot.classList.add('is-collapsing');
        void c.slot.offsetHeight; // flush, so the height below transitions
        c.slot.style.height = '0px';
        // The hold goes with the space it was compensating for, in the same
        // beat and on the same curve. Only from the LAST chunk: a newer one
        // opened behind this one owns the boundary now, and its own collapse
        // is what should let the stream go.
        if (chunkHost.lastElementChild === c.slot) streamHold.release(reduced ? 0 : COLLAPSE_MS);
        step(c, reduced ? 0 : COLLAPSE_MS, () => {
          discard(c);
          render();
        });
      });
    });
  }

  /** Drop every chunk on the floor, mid-settle or not: the meeting is over,
   *  restarting, or the zone is going away. */
  function clearChunks(): void {
    stopInPlace();
    streamHold.clear();
    for (const c of [...settling]) discard(c);
    if (openChunk) {
      openChunk.slot.remove();
      openChunk = null;
    }
  }

  function render(): void {
    if (!live) {
      root.hidden = true;
      return;
    }
    const all = ordered();
    const splitting = all.filter((t) => t.composing);
    // A chunk mid-settle still has words on screen after its turns are gone.
    root.hidden = all.length === 0 && settling.size === 0;
    if (splitting.length > 0 && !inPlace) {
      openChunk ??= mountChunk();
      openChunk.body.replaceChildren(...runOf(splitting));
    } else if (openChunk) {
      // A failed tick returns its words to the stream, so the block they
      // were lifted into goes with no animation — nothing settled. The line
      // it broke is whole again, so the hold goes with it, uncompensated.
      streamHold.drop();
      openChunk.slot.remove();
      openChunk = null;
    }
    lines.replaceChildren(...runOf(streamTurns()));
    streamHold.trim();
    matchProseWidth();
    // Before keepInView, not after: following mode scrolls to whatever the
    // zone's height is when it is asked, and the hold is about to take a
    // line of that height back.
    if (splitAnchor) streamHold.hold(splitAnchor);
    keepInView();
  }

  /**
   * Lift these turns out of the stream into a chunk of their own — the first
   * beat, and what a `composing` frame asks for.
   */
  function split(ids: readonly number[]): void {
    // A settle still running owns turns this one's reading would count. Its
    // note has landed and its words were on their way out, so they go now.
    finishInPlace();
    // Words with a survivor in front of them cannot be lifted into a block
    // above the stream without reordering it — see `inPlace` above. Decided
    // before anything is flagged, because both readings below are of the
    // stream as it stands.
    inPlace = !liftable(ids);
    // Where the surviving stream sits BEFORE the split, for the hold to
    // restore. Read before the turns are flagged: `composing` is what tells
    // `render` who is leaving. An in-place settle breaks no line, so there is
    // nothing for the hold to compensate and it is not asked for one.
    splitAnchor = inPlace ? null : survivorAnchor(ids);
    for (const id of ids) {
      const t = turns.get(id);
      if (t) t.composing = true;
    }
    render();
    splitAnchor = null; // consumed, or dropped if render bailed
  }

  /** Give up whatever an in-place settle was in the middle of, KEEPING its
   *  words: the tick that was taking them has withdrawn, or the meeting is
   *  over. */
  function stopInPlace(): void {
    if (inPlaceTimer !== null) clearTimeout(inPlaceTimer);
    inPlaceTimer = null;
    inPlacePending = [];
    inPlace = false;
    for (const t of turns.values()) t.fading = false;
  }

  /**
   * Finish one now, whatever beat it was on: its note has landed and its
   * words were leaving anyway, and the next split has to read a stream that
   * is not about to change under it. Left running, its own last beat would
   * clear `inPlace` in the middle of the NEXT split and hand a chunk words
   * that are not the front of the stream — the smear, back again, one tick
   * later.
   */
  function finishInPlace(): void {
    if (inPlaceTimer !== null) clearTimeout(inPlaceTimer);
    inPlaceTimer = null;
    for (const id of inPlacePending) turns.delete(id);
    inPlacePending = [];
    inPlace = false;
  }

  /**
   * The in-place settle's two beats — the same two the lift uses, minus the
   * collapse it cannot have. The note lands and the page settles
   * (`NOTE_LAND_MS`), the words fade where they sit (`FADE_MS`), and only
   * then do they leave the run and the stream close over the gap.
   */
  function landInPlace(ids: readonly number[]): void {
    const going = ids.filter((id) => turns.has(id));
    if (going.length === 0) {
      stopInPlace();
      render();
      return;
    }
    inPlacePending = going;
    inPlaceTimer = setTimeout(() => {
      for (const id of going) {
        const t = turns.get(id);
        if (t) t.fading = true;
      }
      render();
      inPlaceTimer = setTimeout(() => {
        finishInPlace();
        render();
      }, FADE_MS);
    }, NOTE_LAND_MS);
  }

  /**
   * The note is in the doc; the settle wash up there takes over. The words do
   * NOT leave with their turns — the block holding them is handed to the
   * settle, which fades them where they sit and only then collapses the
   * space.
   */
  function land(ids: readonly number[]): void {
    if (inPlace) {
      landInPlace(ids);
      return;
    }
    for (const id of ids) turns.delete(id);
    const done = openChunk;
    openChunk = null;
    if (done) settling.add(done); // before render, or the zone hides
    render();
    if (done) settle(done);
  }

  return {
    begin() {
      live = true;
      follow = true;
      sawProgress = false;
      clearChunks();
      turns.clear();
      voices.clear();
      render();
    },
    onTurn(t) {
      if (!live) return;
      if (t.speaker !== undefined) voices.add(t.speaker);
      const known = turns.get(t.turn);
      turns.set(t.turn, {
        turn: t.turn,
        text: t.text,
        final: t.final,
        ...(t.speaker !== undefined ? { speaker: t.speaker } : {}),
        composing: known?.composing ?? false,
      });
      render();
    },
    onProgress(e) {
      if (!live) return;
      sawProgress = true;
      if (e.phase === 'composing') {
        split(e.turns);
        return;
      }
      if (e.phase === 'written') {
        land(e.turns);
        return;
      }
      // `failed` or `empty`: no note carries these words. A failed tick's are
      // composed again in the next one; an empty tick's have had their look
      // and produced nothing. Either way they are still provisional and
      // nothing has been written up, so they go back to the stream rather
      // than fading out of it — the fade means "this is in the notes now",
      // and on an empty tick that would be a lie the reader cannot check.
      stopInPlace();
      for (const id of e.turns) {
        const t = turns.get(id);
        if (t) t.composing = false;
      }
      render();
    },
    setNames(next) {
      names = next;
      render();
    },
    clearSettled() {
      if (!live) return;
      // The guard, and the whole of it: a meeting that reports its ticks is
      // driven by those frames, which are the only thing that knows what a
      // tick actually wrote. Filtering the composing turns out here instead
      // would leave the rest of them — words spoken since the tick fired,
      // which no note covers — being faded away by a note about something
      // else.
      if (sawProgress) return;
      const settled = ordered()
        .filter((t) => t.final)
        .map((t) => t.turn);
      if (settled.length === 0) return;
      // The same two beats a reported tick uses, in one frame: nothing is
      // painted between them, so the words simply stay where they are and
      // then fade.
      split(settled);
      land(settled);
    },
    end() {
      if (live) endedAt = now();
      live = false;
      clearChunks();
      turns.clear();
      voices.clear();
      render();
    },
    active: () => live,
    washActive: () => live || (endedAt > 0 && now() - endedAt < WASH_GRACE_MS),
    destroy() {
      live = false;
      clearChunks();
      resize?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      root.remove();
    },
  };
}
