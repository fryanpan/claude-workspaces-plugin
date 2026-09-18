import { onPlacementChange } from '../card-placement.ts';
import { workspaceIdFromPath } from '../doc-path.ts';
import { resolveDocLink } from '../link-open.ts';
import type { MountScope } from '../mount-scope.ts';
import type { NoteCard } from '../recent-note-cards.ts';
import { noteParts } from './note-links.ts';

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
 * All three draw a note through `drawNote`, so a source written as a markdown
 * link is a short clickable label in every one of them rather than a run of
 * `[label](path)` syntax, and a provenance tag written in backticks — `` `[primary
 * — read 2026-09-18]` `` — is quiet text rather than two backticks the reader
 * has to read past. `note-links.ts` decides which hrefs may be drawn as links
 * and which characters are a backtick span; the elements are built with
 * `createElement` and `textContent` so a note's characters are never parsed as
 * HTML.
 *
 * WHICH WORDS A NOTE IS ABOUT is asked, not announced (Bryan, 2026-09-18:
 * "the quotes are cool, and also unreadable"). A doc with a note on nearly
 * every sentence used to come back with nearly every line underlined, which
 * left the reader nothing to read and nothing to notice. Nothing is lit at
 * rest now except an UNCONFIRMED note's dotted line, which is the certainty
 * signal and is rare; pointing at a caption or a superscript — or tabbing
 * into a caption's link — lights that one note's fact and no other. That is
 * `relight` below, and the classes it writes are the ones `doc.css` draws.
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
  /** The workspace context a RELATIVE href inside a note resolves against —
   *  the same one `createEditor` is given for the doc body, so `[the
   *  plan](plan.md)` in a note lands where the identical link in the prose
   *  lands. Absent on a surface with no workspace, where such an href is left
   *  to the browser to resolve against the page. */
  docLink?: { workspaceId: string; relPath: string; navigate: (url: string) => void };
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
  const { prose, container, marginVisible, onChange, scope, docLink } = opts;

  /** The in-app review URL a relative href names, or null when there is no
   *  workspace context or the path does not resolve to a sibling doc. */
  function inAppHref(href: string): string | null {
    if (!docLink) return null;
    return resolveDocLink({
      href,
      reviewId: docLink.workspaceId,
      relPath: docLink.relPath,
      workspaceId: workspaceIdFromPath(location.pathname),
    });
  }

  /**
   * Draw one note's words into `el`, its markdown links drawn as links and its
   * backtick spans drawn quietly.
   *
   * Every node is built with `createElement` / `textContent`, never from a
   * string of HTML: a note is the author's characters, and the one thing they
   * may not become is markup.
   */
  function drawNote(el: HTMLElement, note: string): void {
    el.textContent = '';
    for (const part of noteParts(note)) {
      if (part.href === undefined) {
        // A provenance tag the author wrote in backticks. The backticks are
        // syntax and stop here; the words are the note's own sans face, a
        // shade smaller and lighter, so the link stays what the eye lands on.
        if (part.code === true) {
          const span = document.createElement('span');
          span.className = 'cw-fn-code';
          span.textContent = part.text;
          el.appendChild(span);
          continue;
        }
        el.appendChild(document.createTextNode(part.text));
        continue;
      }
      const a = document.createElement('a');
      a.className = 'cw-fn-link';
      a.textContent = part.text;
      const inApp = part.external ? null : inAppHref(part.href);
      // The resolved URL goes in the attribute, not only into the click
      // handler, so the status bar, a copy-link and a middle-click all name
      // the same destination a plain click reaches.
      a.href = inApp ?? part.href;
      if (inApp !== null) a.dataset.cwFnInApp = '';
      if (part.external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      el.appendChild(a);
    }
  }

  // Marks THIS editor as one whose notes have a margin to go to. Every
  // `createEditor` draws the same `.cw-fn` decorations — a task body, a live
  // redline — and only the document editor mounts this module, so a rule that
  // hid the superscript on `.cw-fn` alone took the citation off screen in the
  // editors that have no margin to put it in instead.
  //
  // On the CONTAINER, not on the prose root: ProseMirror owns the class
  // attribute of its own DOM node and rewrites it wholesale whenever the
  // view's attribute props change, which would drop this one without a word.
  container.classList.add('cw-fn-margined');
  scope.onCleanup(() => container.classList.remove('cw-fn-margined'));

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
  /** The words the open card is showing, so a refresh can tell whether the
   *  number still means the note the reader tapped. */
  let openNote = '';

  scope.onCleanup(() => {
    sources.remove();
    pop.remove();
  });

  /** A margin caption, wired once to light the words it is about while the
   *  reader points at it or tabs into one of its links. Wired at CREATION,
   *  because `cardFor` reuses the element it already made for this number and
   *  re-wiring on every redraw would stack duplicate listeners. */
  function noteEl(n: string): HTMLElement {
    const el = document.createElement('div');
    scope.listen(el, 'mouseenter', () => hover(n));
    scope.listen(el, 'mouseleave', () => hover(null));
    scope.listen(el, 'focusin', () => hover(n));
    scope.listen(el, 'focusout', () => hover(null));
    return el;
  }

  function cardFor(f: FoundNote): NoteCard {
    const held = cards.get(f.n);
    if (held && held.note === f.note && held.unsure === f.unsure) {
      held.card.anchor = f.anchor;
      return held.card;
    }
    const el = held?.card.el ?? noteEl(f.n);
    el.className = f.unsure ? 'cw-fn-note cw-fn-note-unsure' : 'cw-fn-note';
    drawNote(el, f.note);
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
      drawNote(li, f.note);
      if (f.unsure) li.className = 'cw-fn-note-unsure';
      ol.appendChild(li);
    }
    sources.append(h, ol);
  }

  function closePop(): void {
    if (openN === null) return;
    openN = null;
    openNote = '';
    pop.hidden = true;
    relight();
  }

  /** The note the reader is pointing at or focused inside, if any. */
  let hoverN: string | null = null;

  function hover(n: string | null): void {
    if (hoverN === n) return;
    hoverN = n;
    relight();
  }

  /**
   * Light exactly one note — the one being pointed at, or the one whose card
   * is open — and nothing else.
   *
   * Nothing is lit at rest, so the prose reads as prose; this is the whole of
   * "which words is that note about". The decoration plugin replaces both
   * spans on every rebuild, so the classes are put back by QUERY rather than
   * through a remembered element: a run split by another mark renders as two
   * spans carrying the same number, and both halves are the same note.
   */
  function relight(): void {
    for (const el of prose.querySelectorAll('.cw-fn-on, .cw-fn-fact-on')) {
      el.classList.remove('cw-fn-on', 'cw-fn-fact-on');
    }
    const n = hoverN ?? openN;
    if (n === null) return;
    const id = CSS.escape(n);
    for (const el of prose.querySelectorAll(`.cw-fn[data-cw-fn="${id}"]`)) {
      el.classList.add('cw-fn-on');
    }
    for (const el of prose.querySelectorAll(`.cw-fn-fact[data-cw-fn-for="${id}"]`)) {
      el.classList.add('cw-fn-fact-on');
    }
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
    for (const f of notes) cardFor(f);
    // The open card has to be re-decided, not left standing. Its span was
    // just replaced, the paragraph under it may have moved, and the NUMBER is
    // not an identity: inserting a note earlier in the doc renumbers every
    // one after it, so `2` can come back meaning a different sentence. Same
    // number and same words is the note the reader tapped — re-light and
    // re-place it; anything else closes, because silently swapping the text
    // under their finger is the one outcome they cannot detect.
    if (openN !== null) {
      const still = notes.find((f) => f.n === openN);
      // `marginVisible()` belongs in this check as much as the note does: a
      // reader who moves their cards into the margin mid-tap gets every note
      // as a caption, and the card would be a second copy of the one they are
      // looking at — the same reason a tap does not open one there.
      if (!still || still.note !== openNote || marginVisible()) closePop();
      else {
        pop.classList.toggle('cw-fn-pop-unsure', still.unsure);
        placePop(still.anchor);
      }
    }
    // Whatever the card did, the spans under the lit note are new elements
    // and carry none of the classes the old ones did.
    relight();
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
    openNote = f.note;
    drawNote(pop, f.note);
    pop.classList.toggle('cw-fn-pop-unsure', f.unsure);
    pop.hidden = false;
    relight();
    placePop(target);
  });
  // A tap anywhere else — including on the prose, handled above — closes it.
  scope.listen(container, 'click', (ev) => {
    const el = ev.target as HTMLElement | null;
    if (el && (prose.contains(el) || pop.contains(el))) return;
    closePop();
  });

  // A relative link in a note goes where the same link in the prose goes: the
  // sibling doc's review URL, in THIS tab, because it is the same review
  // session. Only a link whose href this module resolved is taken over —
  // anything else (an external URL, a bare anchor, a path that named no
  // sibling) is the browser's to follow, exactly as the attribute says.
  scope.listen(container, 'click', (ev) => {
    const a = (ev.target as HTMLElement | null)?.closest?.(
      'a.cw-fn-link[data-cw-fn-in-app]',
    ) as HTMLAnchorElement | null;
    const url = a?.getAttribute('href');
    if (!url || !docLink) return;
    ev.preventDefault();
    docLink.navigate(url);
  });

  // The superscript's own half of "which words is this about". A note whose
  // number is hidden (the margin carries it) has its caption instead, and the
  // caption's listeners are wired in `noteEl`.
  scope.listen(prose, 'mouseover', (ev) => {
    const el = (ev.target as HTMLElement | null)?.closest?.('.cw-fn') as HTMLElement | null;
    hover(el?.dataset.cwFn ?? null);
  });
  scope.listen(prose, 'mouseout', () => hover(null));

  // Placement is the reader's, changed from the chrome and from a width
  // boundary, and neither goes through an editor transaction — so without
  // this the card the reader had open outlived the surface that justified it.
  onPlacementChange((target, type, fn) => scope.listen(target, type, fn), refresh);

  refresh();

  return {
    cards: () => (marginVisible() ? notes.map((f) => cardFor(f)) : []),
    refresh,
  };
}
