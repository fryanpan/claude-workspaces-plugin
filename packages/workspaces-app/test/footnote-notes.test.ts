import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { mountFootnoteNotes } from '../src/doc/footnote-notes.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The three faces of a `^[…]` note (doc/footnote-notes.ts): a caption in the
 * margin where there is a column for one, a tap-to-open card where there is
 * not, and a numbered list on paper.
 *
 * The margin and the popover are deliberately EXCLUSIVE. A reader who can
 * already see every note beside the text gains nothing from a tap that opens
 * a second copy of the one they are looking at, and the card would cover the
 * line it belongs to.
 */

const open: Array<() => void> = [];
let uninstall: (() => void) | null = null;

beforeEach(() => {
  setViewport(IPAD);
  uninstall = installSheets('styles.css', 'doc.css');
});
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  uninstall?.();
  uninstall = null;
  document.body.removeAttribute('data-cards');
  document.body.innerHTML = '';
});

const DOC = [
  'A permit takes 94 days^[Planning Department annual report, 2025, table 4.],',
  'and about a third of that waits^[Estimate from three applicants. Unconfirmed.].',
].join(' ');

const PAGE = 'https://harborlight.example.org/staffing';
const LINKED = `Two reviewers serve the city^[[Staffing page, Sep 2026](${PAGE}).].`;

function mount(opts: {
  marginVisible: boolean | (() => boolean);
  md?: string;
  docLink?: { workspaceId: string; relPath: string; navigate: (url: string) => void };
}) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(opts.md ?? DOC));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor: EditorHandle = createEditor({
    parent: container,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  const scope = new MountScope();
  let changes = 0;
  const notes = mountFootnoteNotes({
    prose: editor.editor.view.dom,
    container,
    marginVisible:
      typeof opts.marginVisible === 'function'
        ? opts.marginVisible
        : () => opts.marginVisible === true,
    onChange: () => {
      changes++;
    },
    docLink: opts.docLink,
    scope,
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { editor, container, notes, scope, changed: () => changes };
}

const popover = (c: HTMLElement) => c.querySelector<HTMLElement>('.cw-fn-pop');
const tap = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const supFor = (c: HTMLElement, n: string) =>
  c.querySelector<HTMLElement>(`.cw-fn[data-cw-fn="${n}"]`) as HTMLElement;
const factFor = (c: HTMLElement, n: string) =>
  c.querySelector<HTMLElement>(`.cw-fn-fact[data-cw-fn-for="${n}"]`) as HTMLElement;
const point = (el: Element, over: boolean) =>
  el.dispatchEvent(new MouseEvent(over ? 'mouseover' : 'mouseout', { bubbles: true }));
/** `mouseenter` does not bubble, so it goes straight to the caption. */
const enter = (el: Element, over: boolean) =>
  el.dispatchEvent(new MouseEvent(over ? 'mouseenter' : 'mouseleave'));
const lit = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('.cw-fn-fact-on')].map((el) => el.dataset.cwFnFor);

describe('notes in the margin', () => {
  it('places one card per note, carrying the note text', () => {
    const { notes } = mount({ marginVisible: true });
    expect(notes.cards().map((c) => c.el.textContent)).toEqual([
      'Planning Department annual report, 2025, table 4.',
      'Estimate from three applicants. Unconfirmed.',
    ]);
  });

  it('anchors each card to its own note, so the leader points at the right line', () => {
    const { notes, container } = mount({ marginVisible: true });
    expect(notes.cards().map((c) => (c.anchor as HTMLElement).dataset.cwFn)).toEqual(['1', '2']);
    expect(notes.cards()[0]?.anchor).toBe(supFor(container, '1'));
  });

  it('asks for a dotted leader on the note the author did not confirm', () => {
    const { notes } = mount({ marginVisible: true });
    expect(notes.cards().map((c) => c.leaderClass)).toEqual([
      'cw-leader-fn',
      'cw-leader-fn-unsure',
    ]);
  });

  it('offers no cards at all when the column is off screen', () => {
    const { notes } = mount({ marginVisible: false });
    expect(notes.cards()).toEqual([]);
  });

  it('keeps the same element across a refresh, so the column need not rebuild', () => {
    const { notes } = mount({ marginVisible: true });
    const first = notes.cards()[0]?.el;
    notes.refresh();
    expect(notes.cards()[0]?.el).toBe(first);
  });

  it('drops a card whose note the author deleted', () => {
    const { notes, editor } = mount({ marginVisible: true });
    editor.editor.commands.setContent('A permit takes 94 days on paper.');
    notes.refresh();
    expect(notes.cards()).toEqual([]);
  });
});

describe('the popover on a phone', () => {
  it('opens under the tapped note and shows its text', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '2'));
    expect(popover(container)?.hidden).toBe(false);
    expect(popover(container)?.textContent).toBe('Estimate from three applicants. Unconfirmed.');
  });

  it('closes on a second tap of the same note', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    tap(supFor(container, '1'));
    expect(popover(container)?.hidden).toBe(true);
  });

  it('swaps to the other note rather than opening two', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    tap(supFor(container, '2'));
    expect(container.querySelectorAll('.cw-fn-pop')).toHaveLength(1);
    expect(popover(container)?.textContent).toBe('Estimate from three applicants. Unconfirmed.');
  });

  it('closes on a tap anywhere else', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    tap(container);
    expect(popover(container)?.hidden).toBe(true);
  });

  it('does not open at all where the margin already shows every note', () => {
    const { container } = mount({ marginVisible: true });
    tap(supFor(container, '1'));
    expect(popover(container)?.hidden).toBe(true);
  });

  it('marks the open note so it can be lit', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    expect(supFor(container, '1').classList.contains('cw-fn-on')).toBe(true);
    tap(container);
    expect(supFor(container, '1').classList.contains('cw-fn-on')).toBe(false);
  });
});

describe('an open card while the text underneath changes', () => {
  it('stays on its own note, re-lit and re-placed, when a later edit rebuilds the spans', () => {
    const { container, notes, editor } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    // An edit far from the note: same notes, same numbering, new DOM spans.
    editor.editor.commands.insertContentAt(1, 'Filed in March. ');
    notes.refresh();
    expect(popover(container)?.hidden).toBe(false);
    expect(popover(container)?.textContent).toBe(
      'Planning Department annual report, 2025, table 4.',
    );
    expect(supFor(container, '1').classList.contains('cw-fn-on')).toBe(true);
  });

  it('closes rather than silently showing another note under the same number', () => {
    const { container, notes, editor } = mount({ marginVisible: false });
    tap(supFor(container, '2'));
    // A note inserted BEFORE it: `2` now means a sentence the reader never
    // tapped, so the card must not simply repaint itself.
    editor.editor.commands.insertContentAt(1, 'Filed in March^[Intake log, 2025.]. ');
    notes.refresh();
    expect(popover(container)?.hidden).toBe(true);
    expect(container.querySelectorAll('.cw-fn-on')).toHaveLength(0);
  });

  it('closes when the window grows a margin under it', () => {
    // The real predicate this time, reading the attribute the chrome writes.
    setViewport(PHONE);
    document.body.dataset.cards = 'inline';
    const { container } = mount({
      marginVisible: () => document.body.dataset.cards === 'balloon',
    });
    tap(supFor(container, '1'));
    expect(popover(container)?.hidden).toBe(false);
    document.body.dataset.cards = 'balloon';
    setViewport(IPAD);
    expect(popover(container)?.hidden).toBe(true);
    expect(container.querySelectorAll('.cw-fn-on')).toHaveLength(0);
  });

  it('closes when the author edits the words the card is showing', () => {
    const { container, notes, editor } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    editor.editor.commands.setContent(
      'A permit takes 94 days^[Planning Department annual report, 2026, table 9.].',
    );
    notes.refresh();
    expect(popover(container)?.hidden).toBe(true);
  });
});

describe('an editor with no margin of its own', () => {
  /**
   * Every `createEditor` draws `.cw-fn` decorations — a task body, a live
   * redline — and only the document editor mounts this module. The rule that
   * hides the number where the margin carries the note is keyed on the class
   * this module adds, so those other editors keep the citation on screen.
   */
  it('keeps its superscript under balloon placement, where the doc editor hides it', () => {
    document.body.dataset.cards = 'balloon';
    const { container, scope } = mount({ marginVisible: true });
    const sup = supFor(container, '1');
    expect(styleOf(sup).getPropertyValue('--cw-fn-sup').trim()).toBe('none');
    // Unmounting the notes module is the same DOM an editor that never
    // mounted it has.
    scope.dispose();
    expect(styleOf(sup).getPropertyValue('--cw-fn-sup').trim()).toBe('');
  });
});

describe('the printed sources list', () => {
  it('numbers the notes in document order', () => {
    const { container } = mount({ marginVisible: true });
    const items = [...container.querySelectorAll('.cw-fn-sources ol li')];
    expect(items.map((li) => li.textContent)).toEqual([
      'Planning Department annual report, 2025, table 4.',
      'Estimate from three applicants. Unconfirmed.',
    ]);
  });

  it('is hidden on screen at both widths — the margin and the popover carry it there', () => {
    const { container } = mount({ marginVisible: true });
    const list = container.querySelector<HTMLElement>('.cw-fn-sources');
    if (!list) throw new Error('no sources list');
    expect(styleOf(list).display).toBe('none');
    setViewport(PHONE);
    expect(styleOf(list).display).toBe('none');
  });

  it('holds nothing at all for a doc with no notes (control)', () => {
    const { container } = mount({ marginVisible: true, md: 'A permit takes 94 days on paper.' });
    expect(container.querySelector('.cw-fn-sources')?.textContent).toBe('');
  });
});

describe('a reader who put the cards inline on a wide screen', () => {
  /**
   * The state the first cut got wrong. `balloonMarginVisible` is a STORED
   * preference, not a width test, so at 1180px with cards set to inline
   * there is no margin column and no margin note — and the superscript used
   * to be hidden by a `(min-width: 1101px)` media query anyway, which left
   * the note with no surface at all. Both halves now ask `body[data-cards]`.
   */
  it('still shows the number in the text, and hides it only where the margin has the note', () => {
    const { container } = mount({ marginVisible: false });
    const sup = supFor(container, '1');
    document.body.dataset.cards = 'inline';
    expect(styleOf(sup).getPropertyValue('--cw-fn-sup').trim()).toBe('');
    document.body.dataset.cards = 'balloon';
    expect(styleOf(sup).getPropertyValue('--cw-fn-sup').trim()).toBe('none');
  });

  it('opens the note on a tap at iPad width, because nothing else is showing it', () => {
    document.body.dataset.cards = 'inline';
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    expect(popover(container)?.hidden).toBe(false);
    expect(popover(container)?.textContent).toBe(
      'Planning Department annual report, 2025, table 4.',
    );
  });
});

/**
 * The underline, and who asks for it (Bryan, 2026-09-18: "the quotes are cool,
 * and also unreadable"). A note on nearly every sentence used to mean a line
 * under nearly every sentence. Nothing is lit at rest now; pointing at a note
 * is what asks which words it is about.
 */
describe('the fact underline', () => {
  /**
   * happy-dom answers `''` for a property no author rule set, rather than
   * resolving the initial value — so the unconfirmed fact is read in the same
   * case as the control. It comes back `dotted` from the same getter, which
   * is what makes the empty string mean "nothing draws a line here" rather
   * than "this environment cannot tell".
   */
  it('draws no line under a confirmed note at rest, and keeps the dotted one', () => {
    const { container } = mount({ marginVisible: true });
    expect(styleOf(factFor(container, '1')).borderBottomStyle).toBe('');
    expect(styleOf(factFor(container, '2')).borderBottomStyle).toBe('dotted');
  });

  it('lines the fact while the reader points at its superscript, and only that one', () => {
    const { container } = mount({ marginVisible: false });
    point(supFor(container, '1'), true);
    expect(lit(container)).toEqual(['1']);
    expect(styleOf(factFor(container, '1')).borderBottomStyle).toBe('solid');
    expect(styleOf(factFor(container, '2')).borderBottomStyle).toBe('dotted');
  });

  it('puts it away again when the pointer leaves', () => {
    const { container } = mount({ marginVisible: false });
    point(supFor(container, '1'), true);
    point(supFor(container, '1'), false);
    expect(lit(container)).toEqual([]);
    expect(styleOf(factFor(container, '1')).borderBottomStyle).toBe('');
  });

  it('lines it from the margin caption too, which is the only note on screen there', () => {
    const { container, notes } = mount({ marginVisible: true });
    const card = notes.cards()[0]?.el;
    if (!card) throw new Error('no margin card');
    enter(card, true);
    expect(lit(container)).toEqual(['1']);
    enter(card, false);
    expect(lit(container)).toEqual([]);
  });

  it('lines it when a keyboard reader tabs into a caption link', () => {
    const { container, notes } = mount({
      marginVisible: true,
      md: `Two reviewers serve the city^[[Staffing page](${PAGE}).].`,
    });
    const card = notes.cards()[0]?.el;
    const link = card?.querySelector('a');
    if (!link) throw new Error('no link in the caption');
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(lit(container)).toEqual(['1']);
    link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(lit(container)).toEqual([]);
  });

  it('leaves an unconfirmed fact DOTTED when it lights up, rather than changing stroke', () => {
    const { container } = mount({ marginVisible: false });
    point(supFor(container, '2'), true);
    expect(styleOf(factFor(container, '2')).borderBottomStyle).toBe('dotted');
  });

  it('lights the fact of the note whose card a tap opened', () => {
    const { container } = mount({ marginVisible: false });
    tap(supFor(container, '2'));
    expect(lit(container)).toEqual(['2']);
    tap(container);
    expect(lit(container)).toEqual([]);
  });

  it('puts the line back on the new spans after an edit rebuilds them', () => {
    const { container, notes, editor } = mount({ marginVisible: false });
    tap(supFor(container, '1'));
    editor.editor.commands.insertContentAt(1, 'Filed in March. ');
    notes.refresh();
    expect(lit(container)).toEqual(['1']);
  });
});

/**
 * A note written as a markdown link (Bryan: "the items on the right should be
 * much shorter links to exactly the doc and section"). The note in the FILE is
 * unchanged — it is still the characters the author typed — and all three
 * draws turn those characters into a label the reader can click.
 */
describe('a link inside a note', () => {
  const linkIn = (el: Element | null | undefined) => el?.querySelector('a');

  it('draws the label in the margin caption, not the markdown around it', () => {
    const { notes } = mount({ marginVisible: true, md: LINKED });
    const card = notes.cards()[0]?.el;
    expect(linkIn(card)?.textContent).toBe('Staffing page, Sep 2026');
    expect(card?.textContent).toBe('Staffing page, Sep 2026.');
  });

  it('opens an external link in a new tab, unable to reach back', () => {
    const { notes } = mount({ marginVisible: true, md: LINKED });
    const a = linkIn(notes.cards()[0]?.el);
    expect(a?.getAttribute('href')).toBe(PAGE);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('draws it in the popover a tap opens', () => {
    const { container } = mount({ marginVisible: false, md: LINKED });
    tap(supFor(container, '1'));
    expect(linkIn(popover(container))?.textContent).toBe('Staffing page, Sep 2026');
  });

  it('draws it in the printed sources list', () => {
    const { container } = mount({ marginVisible: true, md: LINKED });
    const li = container.querySelector('.cw-fn-sources ol li');
    expect(linkIn(li)?.getAttribute('href')).toBe(PAGE);
  });

  /**
   * The gate, read through the caption the reader actually sees. Remove the
   * scheme check from `noteLinkHref` and this case fails: the caption grows an
   * `<a href="javascript:alert">` the reader can click. The href is written
   * without brackets on purpose — `javascript:alert(1)` is refused a step
   * earlier by the link pattern, and would pass this case with the check gone.
   */
  it('refuses a script-bearing href and leaves it as plain text', () => {
    const { notes } = mount({
      marginVisible: true,
      md: 'Two reviewers^[[Staffing page](javascript:alert).].',
    });
    const card = notes.cards()[0]?.el;
    expect(card?.querySelectorAll('a')).toHaveLength(0);
    expect(card?.textContent).toBe('[Staffing page](javascript:alert).');
  });

  it('builds the label as text, never as markup', () => {
    const { notes } = mount({
      marginVisible: true,
      md: `Two reviewers^[[<img src=x onerror=1>](${PAGE}).].`,
    });
    const card = notes.cards()[0]?.el;
    expect(card?.querySelectorAll('img')).toHaveLength(0);
    expect(linkIn(card)?.textContent).toBe('<img src=x onerror=1>');
  });
});

describe('a relative link inside a note', () => {
  const REL = 'Two reviewers^[[the intake log](notes/intake.md#sep).].';

  it('navigates in this tab, to where the same link in the prose would go', () => {
    const went: string[] = [];
    const { notes, container } = mount({
      marginVisible: true,
      md: REL,
      docLink: {
        workspaceId: 'w-riverbend',
        relPath: 'docs/permits.md',
        navigate: (url) => went.push(url),
      },
    });
    const card = notes.cards()[0]?.el;
    // The balloon column puts the caption inside `#editor`, which is where the
    // click handler lives (markup-margin.ts appends `.markup-margin` there).
    if (card) container.appendChild(card);
    const a = card?.querySelector('a');
    if (!a) throw new Error('no link in the caption');
    // The resolved destination is in the attribute, so copy-link and
    // middle-click name what a plain click reaches.
    const href = a.getAttribute('href') ?? '';
    expect(href).not.toBe('notes/intake.md#sep');
    expect(href).toContain('docs~notes~intake.md');
    expect(a.getAttribute('target')).toBe(null);
    tap(a);
    expect(went).toEqual([href]);
  });

  it('leaves it to the browser on a surface with no workspace (control)', () => {
    const { notes } = mount({ marginVisible: true, md: REL });
    const a = notes.cards()[0]?.el.querySelector('a');
    expect(a?.getAttribute('href')).toBe('notes/intake.md#sep');
    expect(a?.dataset.cwFnInApp).toBe(undefined);
  });
});
