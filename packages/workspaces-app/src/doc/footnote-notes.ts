import type { MountScope } from '../mount-scope.ts';
import type { NoteCard } from '../recent-note-cards.ts';

/**
 * What a `^[…]` note LOOKS like, once the decoration plugin has said where
 * the notes are.
 *
 * The note is drawn three ways, and which one a reader gets is the one
 * decision this module makes:
 *
 *   the margin   — above 1100px the note is plain grey text beside the line
 *                  it belongs to, joined to the fact by the same leader the
 *                  comment balloons use. These are `NoteCard`s handed to the
 *                  balloon column, so a note and a comment stack against each
 *                  other rather than overlapping (Bryan, on the mock: notes
 *                  are a caption in the margin, not a box).
 *   the popover  — at phone widths there is no margin, so the number is a
 *                  superscript and a tap opens a small card UNDER the line.
 *                  Absolutely positioned, so the prose never moves: a note
 *                  that reflows the paragraph loses the reader's place.
 *   the printout — a numbered "Sources" list at the end of the document,
 *                  `display: none` on screen and visible only on paper,
 *                  where there is no margin and nothing to tap.
 *
 * All three read the same DOM the plugin decorated (`.cw-fn[data-cw-fn]`),
 * so they cannot disagree about what the notes are or how they are numbered.
 */

export interface FootnoteNotesOptions {
  /** The prose root the decorated spans live in. */
  prose: HTMLElement;
  /** The positioned ancestor the popover and the sources list are appended
   *  to — the scrolling `#editor` mount. */
  container: HTMLElement;
  /** Is the balloon column on screen? No column, no margin notes — and the
   *  tap-to-open popover is the phone's half of the same feature. */
  marginVisible: () => boolean;
  /** The card set changed; the column has to lay out again. */
  onChange: () => void;
  scope: MountScope;
}

export interface FootnoteNotesHandle {
  /** The margin cards, for the balloon column to place. Empty when the
   *  column is off screen. */
  cards: () => NoteCard[];
  /** Re-read the decorated spans — wire this to editor transactions. */
  refresh: () => void;
}

/** One note, as read back off the decorated prose. */
interface FoundNote {
  n: string;
  note: string;
  unsure: boolean;
  anchor: HTMLElement;
}

function found(prose: HTMLElement): FoundNote[] {
  const out: FoundNote[] = [];
  const seen = new Set<string>();
  for (const el of prose.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]')) {
    const n = el.dataset.cwFn ?? '';
    // A run split by another mark renders as two spans carrying the same
    // number; the first one is the anchor and the second is not a note.
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push({
      n,
      note: el.dataset.cwFnNote ?? '',
      unsure: el.dataset.cwFnUnsure != null,
      anchor: el,
    });
  }
  return out;
}

export function mountFootnoteNotes(opts: FootnoteNotesOptions): FootnoteNotesHandle {
  const { prose, container, marginVisible, onChange, scope } = opts;

  const cards = new Map<string, { card: NoteCard; note: string; unsure: boolean }>();

  const sources = document.createElement('section');
  sources.className = 'cw-fn-sources';
  sources.setAttribute('aria-hidden', 'true');
  container.appendChild(sources);

  const pop = document.createElement('div');
  pop.className = 'cw-fn-pop';
  pop.hidden = true;
  container.appendChild(pop);
  let openN: string | null = null;

  scope.onCleanup(() => {
    sources.remove();
    pop.remove();
  });

  function cardFor(f: FoundNote): NoteCard {
    const held = cards.get(f.n);
    if (held && held.note === f.note && held.unsure === f.unsure) {
      held.card.anchor = f.anchor;
      return held.card;
    }
    const el = held?.card.el ?? document.createElement('div');
    el.className = f.unsure ? 'cw-fn-note cw-fn-note-unsure' : 'cw-fn-note';
    el.textContent = f.note;
    const card: NoteCard = {
      key: `fn:${f.n}`,
      el,
      anchor: f.anchor,
      leaderClass: f.unsure ? 'cw-leader-fn-unsure' : 'cw-leader-fn',
    };
    cards.set(f.n, { card, note: f.note, unsure: f.unsure });
    return card;
  }

  function renderSources(notes: FoundNote[]): void {
    sources.textContent = '';
    if (notes.length === 0) return;
    const h = document.createElement('h2');
    h.textContent = 'Sources';
    const ol = document.createElement('ol');
    for (const f of notes) {
      const li = document.createElement('li');
      li.textContent = f.note;
      if (f.unsure) li.className = 'cw-fn-note-unsure';
      ol.appendChild(li);
    }
    sources.append(h, ol);
  }

  function closePop(): void {
    if (openN === null) return;
    openN = null;
    pop.hidden = true;
    for (const el of prose.querySelectorAll('.cw-fn-on')) el.classList.remove('cw-fn-on');
  }

  /**
   * Place the card under the PARAGRAPH the tapped note sits in, across the
   * prose column. Under the note's own line instead would cover the rest of
   * the sentence the reader is in the middle of; under the block covers only
   * what comes after it. Content-space coordinates, so the card stays with
   * the text while the reader scrolls.
   */
  function placePop(anchor: HTMLElement): void {
    const box = container.getBoundingClientRect();
    const block = anchor.closest('p, li, blockquote, h1, h2, h3, h4') ?? anchor;
    const a = block.getBoundingClientRect();
    const p = prose.getBoundingClientRect();
    pop.style.top = `${a.bottom - box.top + container.scrollTop + 4}px`;
    pop.style.left = `${p.left - box.left + container.scrollLeft}px`;
    pop.style.width = `${p.width}px`;
  }

  let notes: FoundNote[] = [];

  function refresh(): void {
    if (scope.disposed) return;
    notes = found(prose);
    renderSources(notes);
    const live = new Set(notes.map((f) => f.n));
    for (const [n, held] of cards) {
      if (live.has(n)) continue;
      held.card.el.remove();
      cards.delete(n);
    }
    if (openN !== null && !live.has(openN)) closePop();
    for (const f of notes) cardFor(f);
    onChange();
  }

  scope.listen(prose, 'click', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest?.('.cw-fn') as HTMLElement | null;
    // The margin already shows every note; a tap there would open a second
    // copy of what the reader is looking at.
    if (!target || marginVisible()) {
      closePop();
      return;
    }
    const n = target.dataset.cwFn ?? '';
    const was = openN === n;
    closePop();
    if (was) return;
    const f = notes.find((x) => x.n === n);
    if (!f) return;
    openN = n;
    pop.textContent = f.note;
    pop.classList.toggle('cw-fn-pop-unsure', f.unsure);
    pop.hidden = false;
    target.classList.add('cw-fn-on');
    placePop(target);
  });
  // A tap anywhere else — including on the prose, handled above — closes it.
  scope.listen(container, 'click', (ev) => {
    const el = ev.target as HTMLElement | null;
    if (el && (prose.contains(el) || pop.contains(el))) return;
    closePop();
  });

  refresh();

  return {
    cards: () => (marginVisible() ? notes.map((f) => cardFor(f)) : []),
    refresh,
  };
}
