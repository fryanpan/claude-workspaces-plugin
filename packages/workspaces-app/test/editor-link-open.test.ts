import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Following a link in a doc you can also edit.
 *
 * The doc opens editable for anyone who can write it, and there is no longer
 * a mode to leave to read it. That made the old gesture — Cmd/Ctrl+Click — the
 * only way to follow a link, and a touch screen has no such gesture: on a
 * phone a link in your own notes had become unreachable. A single tap or click
 * now opens it.
 *
 * Driven through the REAL editor: the content is parsed from markdown into the
 * Yjs fragment, Tiptap renders the anchor, and the case clicks the anchor the
 * rendered DOM actually has. Nothing here asserts on source text, and the
 * widths are set the way the app sees them, because the phone is the case this
 * exists for.
 *
 * All fixtures synthetic — Riverbend and Harborlight are place names, not
 * anybody's site.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  setViewportWidth(1024);
});

/** The two widths every UI change here is checked at: the phone, and the
 *  iPad in landscape. */
const WIDTHS = [430, 1180] as const;

function setViewportWidth(w: number): void {
  (
    window as unknown as { happyDOM: { setInnerWidth: (w: number) => void } }
  ).happyDOM.setInnerWidth(w);
}

/** Mount the real editor over `md`. Relative links are the last describe
 *  block's business; every case above it uses an absolute one. */
function mount(
  md: string,
  docLink?: { workspaceId: string; relPath: string; navigate: (url: string) => void },
): EditorHandle {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    // The state the doc is in for everyone who can write it.
    editable: true,
    ...(docLink ? { docLink } : {}),
  });
  open.push(() => editor.destroy());
  return editor;
}

const anchor = (): HTMLAnchorElement => {
  const a = document.querySelector('.ProseMirror a[href]') as HTMLAnchorElement | null;
  if (!a) throw new Error('the editor rendered no link to click');
  return a;
};

/** A click as a browser reports one. `detail` is the click COUNT — 1 for a
 *  tap and for a first click, 2 and 3 for the double and triple clicks that
 *  select words to retype them. */
function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      ...init,
    }),
  );
}

/** Watch `window.open` and report what it was handed. */
function watchOpen(): { calls: unknown[][] } {
  const spy = vi.fn();
  vi.stubGlobal('open', spy);
  return { calls: spy.mock.calls };
}

const LINKED = 'The [Riverbend permit page](https://example.invalid/riverbend) has the dates.';

describe('a tap opens a link while the doc is editable', () => {
  for (const width of WIDTHS) {
    it(`opens on a single click at ${width}`, () => {
      setViewportWidth(width);
      const opened = watchOpen();
      const editor = mount(LINKED);
      expect(editor.editor.isEditable).toBe(true);
      click(anchor());
      expect(opened.calls).toEqual([
        ['https://example.invalid/riverbend', '_blank', 'noopener,noreferrer'],
      ]);
    });

    it(`still opens on Cmd-click at ${width}, which is what a mouse user learned`, () => {
      setViewportWidth(width);
      const opened = watchOpen();
      mount(LINKED);
      click(anchor(), { metaKey: true });
      expect(opened.calls.length).toBe(1);
    });
  }

  it('opens a mail link the same way', () => {
    setViewportWidth(430);
    const opened = watchOpen();
    mount('Ask [the clerk](mailto:clerk@example.invalid) for the file.');
    click(anchor());
    expect(opened.calls).toEqual([
      ['mailto:clerk@example.invalid', '_blank', 'noopener,noreferrer'],
    ]);
  });

  it('opens nothing for a script-bearing href', () => {
    setViewportWidth(430);
    const opened = watchOpen();
    mount('A [trap](javascript:alert(1)) in the prose.');
    // The anchor is still rendered — `anchor()` throws if it is not — so this
    // is a click on something, not a click on nothing.
    const a = anchor();
    expect(a.getAttribute('href')).not.toContain('javascript');
    click(a);
    expect(opened.calls).toEqual([]);
  });
});

/**
 * The gestures that are not the opening one.
 *
 * Alt-click is the one that matters: it is how a link's own words stay
 * editable on a doc that is always editable. Double-click is NOT on that
 * list, and cannot be — a browser sends the first click of a double click
 * with `detail === 1`, so the link has opened before the second arrives.
 */
describe('the gestures that are not the opening one', () => {
  it('opens once for a double click, not twice — the second click is refused', () => {
    setViewportWidth(1180);
    const opened = watchOpen();
    mount(LINKED);
    const a = anchor();
    // A browser's real sequence for a double click.
    click(a, { detail: 1 });
    click(a, { detail: 2 });
    expect(opened.calls.length).toBe(1);
  });

  it('leaves Alt-click alone — the way to put the caret inside a link', () => {
    setViewportWidth(1180);
    const opened = watchOpen();
    mount(LINKED);
    click(anchor(), { altKey: true });
    expect(opened.calls).toEqual([]);
  });

  it('leaves Shift-click alone, which extends a selection across it', () => {
    setViewportWidth(1180);
    const opened = watchOpen();
    mount(LINKED);
    click(anchor(), { shiftKey: true });
    expect(opened.calls).toEqual([]);
  });

  it('leaves a secondary-button click to the context menu', () => {
    setViewportWidth(1180);
    const opened = watchOpen();
    mount(LINKED);
    click(anchor(), { button: 2 });
    expect(opened.calls).toEqual([]);
  });
});

/**
 * A link somebody has already commented on.
 *
 * Its words then carry both an anchor and a comment highlight, and only one of
 * them can have the plain click. The highlight is the ONLY way into that
 * thread from the prose — the card in the margin is the other, and on a phone
 * there is no margin — so taking the plain click for the link leaves a reader
 * unable to reopen their own comment by pointing at what it is about. The link
 * keeps Cmd/Ctrl-click, which is already the mouse gesture for "open this, but
 * not here".
 *
 * The decoration is the real one: `setThreadRanges` is what the doc's thread
 * projection calls, and the span these cases click is the span it renders.
 */
describe('a link the reader has commented on', () => {
  /** Put a comment highlight over the whole of the rendered link. */
  function highlightTheLink(editor: EditorHandle): void {
    const a = anchor();
    const from = editor.editor.view.posAtDOM(a, 0);
    const to = from + (a.textContent ?? '').length;
    editor.setThreadRanges([{ id: 't1', from, to, status: 'open' }], null);
  }

  /** The click target inside the highlight, whichever way the two spans nest. */
  const inHighlight = (): HTMLElement => {
    const el = document.querySelector('.ProseMirror .thread-range') as HTMLElement | null;
    if (!el) throw new Error('no highlight was rendered over the link');
    return el;
  };

  for (const width of WIDTHS) {
    it(`opens the thread, not the page, on a plain click at ${width}`, () => {
      setViewportWidth(width);
      const opened = watchOpen();
      const editor = mount(LINKED);
      highlightTheLink(editor);
      click(inHighlight());
      expect(opened.calls).toEqual([]);
    });
  }

  it('lets the click through, so the highlight handler above can open the thread', () => {
    setViewportWidth(430);
    watchOpen();
    const editor = mount(LINKED);
    highlightTheLink(editor);
    // `wireThreadRangeClicks` listens on the mount ABOVE the editor's own DOM,
    // so a link handler that swallowed the event would leave the thread
    // unreachable even with nothing opened.
    const reached: string[] = [];
    document.body.addEventListener('click', () => reached.push('mount'));
    click(inHighlight());
    expect(reached).toEqual(['mount']);
  });

  it('still opens the page on a Cmd-click, which is the way out to the link', () => {
    setViewportWidth(1180);
    const opened = watchOpen();
    const editor = mount(LINKED);
    highlightTheLink(editor);
    click(inHighlight(), { metaKey: true });
    expect(opened.calls).toEqual([
      ['https://example.invalid/riverbend', '_blank', 'noopener,noreferrer'],
    ]);
  });

  /** THE CONTROL: the same link with no comment on it still opens on a plain
   *  click, so the case above is about the highlight and not about links. */
  it('opens on a plain click when nothing has been commented on it', () => {
    setViewportWidth(430);
    const opened = watchOpen();
    mount(LINKED);
    click(anchor());
    expect(opened.calls.length).toBe(1);
  });
});

/**
 * A relative link — `[the data](part-1/riverbend-data.mdx)` — names a FILE,
 * and only the server knows which doc on the board is bound to it. A tap goes
 * to the board's open route, which answers with that doc's page; Cmd/Ctrl
 * opens the same address in a new tab, and Alt still puts the caret in it.
 * Before this, Tiptap drew `notes/…` as `href=""` (its pattern blanks a path
 * whose first segment has no dash), and the rest resolved against the doc
 * page's own address, which names nothing.
 *
 * The real headless-browser proof, through a real server's redirect, is
 * `relative-link-open-browser.test.ts`.
 */
describe('a relative link opens through the board', () => {
  const PAGE = 'http://localhost:3000/workspaces/w-harbor/docs/guide';
  const RELATIVE = [
    'Read [the Riverbend data](part-1/riverbend-data.mdx) first,',
    'then [the Saltmarsh tides](notes/saltmarsh-tides.md).',
  ].join(' ');
  const openRoute = (path: string): string =>
    `/workspaces/w-harbor/open?${new URLSearchParams({ path, from: 'guide' }).toString()}`;

  function atPage(): { assigned: string[] } {
    (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(PAGE);
    const assigned: string[] = [];
    vi.spyOn(window.location, 'assign').mockImplementation((u: string | URL) => {
      assigned.push(String(u));
    });
    return { assigned };
  }

  const links = (): HTMLAnchorElement[] =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('.ProseMirror a'));

  it('draws every relative link with its own target, not an empty href', () => {
    atPage();
    mount(RELATIVE);
    expect(links().map((a) => a.getAttribute('href'))).toEqual([
      'part-1/riverbend-data.mdx',
      'notes/saltmarsh-tides.md',
    ]);
  });

  it('still draws a script-bearing href as nothing', () => {
    atPage();
    mount('A [trap](javascript:alert(1)) and [another](java\tscript:alert(2)).');
    for (const a of links()) expect(a.getAttribute('href') ?? '').not.toMatch(/script/i);
  });

  for (const width of WIDTHS) {
    it(`a tap at ${width} opens the doc in this tab through the open route`, () => {
      setViewportWidth(width);
      const page = atPage();
      const opened = watchOpen();
      mount(RELATIVE);
      const [riverbend, saltmarsh] = links();
      if (!riverbend || !saltmarsh) throw new Error('two links were not drawn');
      click(riverbend);
      click(saltmarsh);
      expect(page.assigned).toEqual([
        openRoute('part-1/riverbend-data.mdx'),
        openRoute('notes/saltmarsh-tides.md'),
      ]);
      expect(opened.calls).toEqual([]);
    });
  }

  it('Cmd- or Ctrl-click opens the same address in a new tab and leaves this one', () => {
    setViewportWidth(1180);
    const page = atPage();
    const opened = watchOpen();
    mount(RELATIVE);
    const a = links()[0];
    if (!a) throw new Error('no link');
    click(a, { metaKey: true });
    click(a, { ctrlKey: true });
    const want = [openRoute('part-1/riverbend-data.mdx'), '_blank', 'noopener,noreferrer'];
    expect(opened.calls).toEqual([want, want]);
    expect(page.assigned).toEqual([]);
  });

  it('a folder-browse member still opens its sibling in-app, and Cmd-click in a new tab', () => {
    setViewportWidth(1180);
    const page = atPage();
    const opened = watchOpen();
    const navigated: string[] = [];
    mount(RELATIVE, {
      workspaceId: 'set-harbor',
      relPath: 'guide.md',
      navigate: (url) => navigated.push(url),
    });
    const a = links()[0];
    if (!a) throw new Error('no link');
    click(a);
    click(a, { metaKey: true });
    expect(navigated.length).toBe(1);
    expect(navigated[0]).toContain(encodeURIComponent('set-harbor:part-1~riverbend-data.mdx'));
    expect(opened.calls).toEqual([[navigated[0], '_blank', 'noopener,noreferrer']]);
    expect(page.assigned).toEqual([]);
  });

  it('leaves Alt-click to the editor, which is how the link text is edited', () => {
    setViewportWidth(1180);
    const page = atPage();
    const opened = watchOpen();
    mount(RELATIVE);
    const a = links()[0];
    if (!a) throw new Error('no link');
    const ev = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      altKey: true,
    });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(page.assigned).toEqual([]);
    expect(opened.calls).toEqual([]);
  });
});
