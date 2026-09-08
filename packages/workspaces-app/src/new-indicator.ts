/**
 * The one new-content indicator: a pill at the top of the document and a pill
 * at the bottom, each saying IN WORDS what the reader has not seen that way.
 *
 * It replaced four separate reports of the same fact — two edge markers for
 * tinted notes, the off-screen comment hints in the balloon column, and the
 * top bar's "N waiting on you" chip. Four controls counting overlapping sets
 * meant a reader had to add them up to answer one question, and three of the
 * four could be on screen at once saying different numbers.
 *
 * WHAT IT COUNTS. "New" is what was written since the reader last read there:
 * notes the note-taker composed (the tint, settle-wash.ts) and replies posted
 * on threads the reader has not dwelt on (comment-seen.ts). An unanswered
 * question or review item addressed to the reader is counted separately and
 * is the only state that earns colour — grey "4 new", amber "1 question · 2
 * new". Nothing is rendered at zero: a permanent "0 new" is metadata the
 * reader cannot act on.
 *
 * WHY A STRIP RATHER THAN A FLOATING PILL. Each pill sits in its own strip
 * OUTSIDE the scroll area, so it cannot cover the first or last comment card
 * or the prose beside it — the thing the floating hints did whenever the
 * reader scrolled to either end. An empty strip is hidden, so it costs no
 * height. On a wide layout the strip is lifted out of the flow and given the
 * balloon column's own footprint, which is where anything said ABOUT the
 * document already lives; at phone widths there is no column, so the strips
 * are real rows at the top and bottom of the pane and the prose sits between
 * them. The action dock (Make Plan and friends) keeps its own row: the
 * bottom strip is measured clear of it rather than sharing it.
 */
import type { MountScope } from './mount-scope.ts';

export type NewDirection = 'above' | 'below';

export interface NewCount {
  /** Unanswered questions and review items lying that way. */
  questions: number;
  /** Everything else written since the reader last read there. */
  fresh: number;
}

export function emptyNewCount(): NewCount {
  return { questions: 0, fresh: 0 };
}

export function newCountTotal(c: NewCount): number {
  return c.questions + c.fresh;
}

export interface NewPillPart {
  count: number;
  word: string;
}

/**
 * The pill's words, in the order they read. Questions first: they are the
 * half the reader has to answer, and the half that colours the pill.
 */
export function newPillParts(c: NewCount): NewPillPart[] {
  const parts: NewPillPart[] = [];
  if (c.questions > 0)
    parts.push({ count: c.questions, word: c.questions === 1 ? 'question' : 'questions' });
  if (c.fresh > 0) parts.push({ count: c.fresh, word: 'new' });
  return parts;
}

/** The full sentence, for assistive tech and the tooltip. */
export function newPillLabel(c: NewCount, dir: NewDirection): string {
  const parts = newPillParts(c).map((p) => `${p.count} ${p.word}`);
  if (parts.length === 0) return '';
  return `${parts.join(' and ')} ${dir}`;
}

export interface NewIndicatorOpts {
  /** The positioned pane the strips live in (`#editor-pane`). */
  pane: HTMLElement;
  /** The element that scrolls the prose (`#editor`). */
  scroller: HTMLElement;
  /** The balloon column the strips line up with on a wide layout. */
  marginEl: HTMLElement | null;
  /** Is that column on screen at this width / placement? */
  marginVisible: () => boolean;
  /** The floating action dock the bottom strip must stay clear of. */
  dockEl?: () => HTMLElement | null;
  onJump: (dir: NewDirection) => void;
  scope: MountScope;
}

export interface NewIndicatorHandle {
  /** Paint both pills. */
  render: (above: NewCount, below: NewCount) => void;
  /** Re-seat the strips against the column and the dock. */
  place: () => void;
  destroy: () => void;
}

/** Gap between the bottom strip and the dock below it. */
const DOCK_GAP = 10;

function buildPill(dir: NewDirection): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cw-edge cw-edge-${dir === 'above' ? 'top' : 'bottom'}`;
  b.hidden = true;
  return b;
}

function buildStrip(dir: NewDirection, pill: HTMLElement): HTMLElement {
  const s = document.createElement('div');
  s.className = `edge-strip edge-strip-${dir === 'above' ? 'top' : 'bottom'}`;
  s.hidden = true;
  s.appendChild(pill);
  return s;
}

/** Paint one pill; hide it — and the strip around it — at zero. */
export function renderNewPill(pill: HTMLElement, c: NewCount, dir: NewDirection): void {
  const total = newCountTotal(c);
  pill.dataset.questions = String(c.questions);
  pill.dataset.fresh = String(c.fresh);
  pill.hidden = total === 0;
  const strip = pill.parentElement;
  if (strip?.classList.contains('edge-strip')) strip.hidden = pill.hidden;
  pill.textContent = '';
  if (total === 0) {
    pill.removeAttribute('aria-label');
    pill.title = '';
    return;
  }
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = dir === 'above' ? '▲' : '▼';
  pill.appendChild(chev);
  newPillParts(c).forEach((p, i) => {
    if (i > 0) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = ' · ';
      pill.appendChild(dot);
    }
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(p.count);
    pill.appendChild(n);
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = ` ${p.word}`;
    pill.appendChild(w);
  });
  // Colour only for the half that needs an answer.
  pill.classList.toggle('has-ask', c.questions > 0);
  const sentence = newPillLabel(c, dir);
  pill.title = sentence;
  pill.setAttribute('aria-label', `${sentence} — jump to the nearest`);
}

export function mountNewIndicator(opts: NewIndicatorOpts): NewIndicatorHandle {
  const { pane, scroller, scope } = opts;
  const topPill = buildPill('above');
  const botPill = buildPill('below');
  const topStrip = buildStrip('above', topPill);
  const botStrip = buildStrip('below', botPill);
  // Outside the scroll area, and on the right side of it: the top strip
  // before the scroller, the bottom strip after it, so at phone width the
  // document sits between them rather than under either.
  scroller.before(topStrip);
  scroller.after(botStrip);

  /** How much room the dock needs under the bottom strip, in pixels. */
  function dockClearance(): number {
    const dock = opts.dockEl?.() ?? null;
    if (!dock || dock.hidden) return 0;
    const r = dock.getBoundingClientRect();
    return r.height > 0 ? r.height + DOCK_GAP : 0;
  }

  function place(): void {
    const wide = opts.marginVisible();
    const column = wide && opts.marginEl ? opts.marginEl.getBoundingClientRect() : null;
    if (!column || column.width === 0) {
      // No column to sit in: ordinary rows, whatever the width. The class
      // goes with the insets, so a strip is never floated with nothing to
      // float against.
      for (const s of [topStrip, botStrip]) {
        s.classList.remove('is-floating');
        s.style.left = '';
        s.style.width = '';
        s.style.top = '';
        s.style.bottom = '';
      }
      botStrip.style.marginBottom = `${dockClearance()}px`;
      return;
    }
    const paneRect = pane.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    botStrip.style.marginBottom = '';
    for (const s of [topStrip, botStrip]) {
      s.classList.add('is-floating');
      s.style.left = `${Math.round(column.left - paneRect.left)}px`;
      s.style.width = `${Math.round(column.width)}px`;
    }
    topStrip.style.top = `${Math.max(0, Math.round(scrollRect.top - paneRect.top)) + 10}px`;
    botStrip.style.bottom = `${Math.round(dockClearance()) + 22}px`;
  }

  function render(above: NewCount, below: NewCount): void {
    renderNewPill(topPill, above, 'above');
    renderNewPill(botPill, below, 'below');
    place();
  }

  scope.listen(topPill, 'click', () => opts.onJump('above'));
  scope.listen(botPill, 'click', () => opts.onJump('below'));
  scope.onCleanup(() => {
    topStrip.remove();
    botStrip.remove();
  });

  return {
    render,
    place,
    destroy: () => {
      topStrip.remove();
      botStrip.remove();
    },
  };
}
