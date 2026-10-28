/**
 * The coach on a board, a doc or the front page: what the owner is looking at
 * and writing, sent to the server, and the coach's "Hi, I'm noticing…" card
 * when it has something to say.
 *
 * What he is looking at: one small POST to `/coach/here` when the page
 * opens (and again once a doc's text has arrived), when it is hidden or
 * shown, and when he stops scrolling, with the heading and the passage in
 * view. The server drops a repeat, so only a
 * change reaches the coach.
 *
 * What he writes (doc pages): the paragraph he is typing in, sent when he
 * pauses for `WROTE_PAUSE_MS` or moves to another paragraph. A pause is where
 * a thought ends; sending each keystroke would make each one a coach turn.
 *
 * Only the owner has a coach. Anyone else's first POST gets an empty 204,
 * and the page then stops: no more beacons, and the stream is never opened.
 * The front page and the review walk name no board, so each says which page
 * it is (`page`) and nothing more: no heading, no passage. They are where he
 * answers review items, most of all from his phone, and a page that said
 * nothing left those stays out of every digest. The server draws the front
 * page's coach section only for the owner, and the front page mounts the
 * card only when the section is there.
 *
 * The card: calm by default. It sits in the bottom-left corner of every
 * page he has open, does not move or pulse, and stays until he answers it in
 * any of them; the server then clears it on the rest. A thumbs up answers at
 * once; a thumbs down opens a box above the thumbs for why, and the same
 * button sends it. The stream is told where the page is, and on a board the
 * coach does not hear from the card says so in place of the switch that
 * turns it off. Drawn in a shadow root so no page's stylesheet reaches it
 * and it adds no rule to any.
 */

const HERE_URL = '/coach/here';
const STREAM_URL = '/coach/stream';
const BOARDS_URL = '/coach/boards';
/** A typing pause this long sends the paragraph. */
export const WROTE_PAUSE_MS = 3_000;
/** Scrolling has stopped once it is this quiet: the passage he stopped at is
 *  the one he reads, not each one he scrolled past. */
export const SCROLL_SETTLE_MS = 1_000;
const PASSAGE_CHARS = 600;
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td';

export interface CoachMomentView {
  id: string;
  at: number;
  name: string;
  line: string;
  goal: string;
}

type Frame =
  | { type: 'moment'; moment: CoachMomentView; off?: boolean }
  | { type: 'clear'; id: string }
  | { type: 'idle' };

const THUMB_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.5l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/></svg>';
const THUMB_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.5l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z"/></svg>';
const OFF_HERE = 'Coach is off for this board';
const TURN_OFF = 'Coach off for this board';

export interface CoachCardOptions {
  /** The board, or none on the front page and the review walk. */
  workspaceId?: string;
  /** A page that names no board: the front page or the review walk. */
  page?: 'home' | 'review';
  docId?: string;
  /** The doc's editor, whose headings say which part he is reading. */
  root?: HTMLElement;
  /** Injected by tests. */
  /** Answers the status, or 0 when the request never landed. */
  post?: (url: string, body: unknown) => Promise<number>;
  openStream?: (url: string) => EventSource;
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.cw-coach { position: fixed; left: 16px; bottom: calc(var(--kb-bottom, 0px) + var(--doc-dock-h, 0px) + var(--board-bottom-bar, 0px) + 16px); z-index: 1050; width: min(340px, calc(100vw - 136px)); padding: 12px 14px; background: #fff; color: #1b1f23; border: 1px solid #d8dee4; border-left: 3px solid #5b7f4e; border-radius: 8px; box-shadow: 0 4px 16px rgba(27,31,35,.12); }
.cw-coach-who { margin: 0 0 4px; font-size: 12.5px; font-weight: 600; color: #5b7f4e; }
.cw-coach-line { margin: 0 0 6px; font-size: 14.5px; line-height: 1.4; }
.cw-coach-goal { margin: 0 0 10px; font-size: 12.5px; line-height: 1.35; color: #6e7781; }
.cw-coach-acts { display: flex; gap: 6px; }
.cw-coach-acts button { flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 8px; border: 1px solid #d8dee4; border-radius: 6px; background: #fff; color: #1b1f23; font-size: 13.5px; cursor: pointer; }
.cw-coach-acts svg { width: 18px; height: 18px; flex: none; }
.cw-coach-why { display: block; width: 100%; min-height: 64px; margin: 0 0 8px; padding: 8px 10px; border: 1px solid #d8dee4; border-radius: 6px; background: #fff; color: #1b1f23; font-size: 16px; line-height: 1.35; resize: none; }
.cw-coach-why:focus { outline: 2px solid #5b7f4e; outline-offset: 0; border-color: #5b7f4e; }
.cw-coach-acts button:hover { background: #f6f8fa; }
.cw-coach-acts button:disabled { opacity: .55; cursor: default; }
.cw-coach-off { display: block; margin: 8px 0 0; padding: 6px 0; min-height: 32px; border: none; background: none; color: #6e7781; font-size: 12.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.cw-coach-off:disabled { opacity: .55; cursor: default; }
span.cw-coach-off { text-decoration: none; cursor: default; }
`;

async function defaultPost(url: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A phone freezes a page as it hides, and the `left` it sends then has
      // to outlive the page, or the stay runs on as if he were still there.
      keepalive: true,
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** The last heading above the fold. */
function headingInView(root: HTMLElement): string | undefined {
  let heading: string | undefined;
  for (const h of root.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    if (h.getBoundingClientRect().top > 120) break;
    heading = h.textContent?.trim() || heading;
  }
  return heading;
}

/** The text of the blocks on screen, up to `PASSAGE_CHARS`. */
function passageInView(root: HTMLElement): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const el of root.querySelectorAll<HTMLElement>(BLOCKS)) {
    if (el.parentElement?.closest(BLOCKS)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0) continue;
    if (r.top > window.innerHeight) break;
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    parts.push(t);
    length += t.length + 1;
    if (length >= PASSAGE_CHARS) break;
  }
  return parts.length ? parts.join(' ').slice(0, PASSAGE_CHARS) : undefined;
}

/** The paragraph the caret is in, inside the doc. */
function blockAtCaret(root: HTMLElement): HTMLElement | null {
  const node = document.getSelection()?.anchorNode ?? null;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const block = el?.closest<HTMLElement>(BLOCKS) ?? null;
  return block && root.contains(block) ? block : null;
}

/** The last heading before `block` in the doc. */
function headingBefore(root: HTMLElement, block: HTMLElement): string | undefined {
  let heading: string | undefined;
  for (const h of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (h === block || !(h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      break;
    }
    heading = h.textContent?.trim() || heading;
  }
  return heading;
}

export interface CoachCard {
  destroy(): void;
}

export function mountCoachCard(opts: CoachCardOptions): CoachCard {
  const post = opts.post ?? defaultPost;
  const root = opts.root;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let stopped = false;
  let stream: EventSource | null = null;
  let host: HTMLElement | null = null;
  let shown: CoachMomentView | null = null;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  /** The paragraph he is typing in, until it is sent. */
  let writing: HTMLElement | null = null;

  const hidden = () => document.visibilityState === 'hidden';
  const where = () => ({
    workspaceId: opts.workspaceId,
    ...(opts.docId ? { docId: opts.docId } : {}),
    visible: !hidden(),
  });

  const view = (): Promise<number> => {
    if (!opts.workspaceId) {
      if (!opts.page) return Promise.resolve(200);
      return post(HERE_URL, { kind: 'view', page: opts.page, visible: !hidden(), timeZone });
    }
    const heading = root ? headingInView(root) : undefined;
    const text = root ? passageInView(root) : undefined;
    return post(HERE_URL, {
      kind: 'view',
      ...where(),
      timeZone,
      ...(heading ? { heading } : {}),
      ...(text ? { text } : {}),
    });
  };

  const sendWriting = () => {
    clearTimeout(pause);
    const block = writing;
    writing = null;
    if (stopped || !block || !root || !opts.docId || !opts.workspaceId) return;
    const text = block.textContent?.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const heading = headingBefore(root, block);
    // He typed it while he could see it, even if the tab has just gone.
    void post(HERE_URL, {
      kind: 'wrote',
      ...where(),
      visible: true,
      ...(heading ? { heading } : {}),
      text,
    });
  };

  const onInput = () => {
    if (stopped || !root) return;
    const block = blockAtCaret(root);
    if (writing && block !== writing) sendWriting();
    writing = block;
    clearTimeout(pause);
    pause = setTimeout(sendWriting, WROTE_PAUSE_MS);
  };
  // Moving the caret to another paragraph ends the one he was writing.
  const onSelection = () => {
    if (writing && root && blockAtCaret(root) !== writing) sendWriting();
  };
  // A tab in the background says nothing about where he is: on another
  // device he may be reading something else, and its view would close the
  // moment there.
  // A page with no board has no passage to report, so scrolling says nothing.
  const onScroll = () => {
    if (stopped || hidden() || !opts.workspaceId) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (!hidden()) void view();
    }, SCROLL_SETTLE_MS);
  };
  const onVisibility = () => {
    if (stopped || (!opts.workspaceId && !opts.page)) return;
    if (document.visibilityState === 'hidden') sendWriting();
    void view();
  };

  const hide = (id?: string) => {
    if (id && shown?.id !== id) return;
    shown = null;
    setOff = () => {};
    host?.remove();
    host = null;
  };

  const answer = async (id: string, body: Record<string, string>, buttons: HTMLButtonElement[]) => {
    for (const b of buttons) b.disabled = true;
    if ((await post(`/coach/moments/${encodeURIComponent(id)}/answer`, body)) === 200) hide(id);
    else for (const b of buttons) b.disabled = false;
  };

  /** The slot under the thumbs: the switch, or that the coach is off here.
   *  Both are one line of the same height, so the card does not change size. */
  let setOff: (off: boolean) => void = () => {};

  const show = (m: CoachMomentView, off: boolean) => {
    // Told again (a board turned on or off, a page reconnecting): the card
    // stays as it is, and only the line under the thumbs may change.
    if (shown?.id === m.id && host) return setOff(off);
    hide();
    shown = m;
    host = document.createElement('div');
    host.className = 'coach-card-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const card = document.createElement('div');
    card.className = 'cw-coach';
    card.setAttribute('role', 'status');
    const line = (cls: string, text: string) => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      return p;
    };
    const acts = document.createElement('div');
    acts.className = 'cw-coach-acts';
    const thumb = (value: 'up' | 'down', icon: string, label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.answer = value;
      b.setAttribute('aria-label', label);
      b.innerHTML = `${icon}<span></span>`;
      (b.querySelector('span') as HTMLSpanElement).textContent = label;
      return b;
    };
    const up = thumb('up', THUMB_UP, 'Helpful');
    const down = thumb('down', THUMB_DOWN, 'Not helpful');
    const buttons = [up, down];
    let why: HTMLTextAreaElement | null = null;
    up.addEventListener('click', () => void answer(m.id, { answer: 'up' }, buttons));
    down.addEventListener('click', () => {
      if (why) {
        const text = why.value.trim();
        void answer(m.id, text ? { answer: 'down', text } : { answer: 'down' }, buttons);
        return;
      }
      // The box opens above the thumbs; the card grows upward from its
      // bottom edge, so the button he pressed stays under his finger.
      why = document.createElement('textarea');
      why.className = 'cw-coach-why';
      why.maxLength = 1_000;
      why.placeholder = 'What was off? (optional)';
      why.setAttribute('aria-label', 'What was off');
      card.insertBefore(why, acts);
      down.setAttribute('aria-label', 'Send');
      (down.querySelector('span') as HTMLSpanElement).textContent = 'Send';
      why.focus();
    });
    acts.append(up, down);
    card.append(
      line('cw-coach-who', m.name),
      line('cw-coach-line', m.line),
      line('cw-coach-goal', `Your goal: ${m.goal}`),
      acts,
    );
    // The front page is on no board, so it has nothing to turn off.
    const workspaceId = opts.workspaceId;
    if (workspaceId) {
      let slot: HTMLElement | null = null;
      setOff = (isOff) => {
        const next = isOff ? document.createElement('span') : document.createElement('button');
        next.className = 'cw-coach-off';
        next.textContent = isOff ? OFF_HERE : TURN_OFF;
        if (next instanceof HTMLButtonElement) {
          next.type = 'button';
          next.addEventListener('click', async () => {
            next.disabled = true;
            const status = await post(BOARDS_URL, { workspaceId, off: true });
            if (status === 200) setOff(true);
            else next.disabled = false;
          });
        }
        if (slot) slot.replaceWith(next);
        else card.append(next);
        slot = next;
      };
      setOff(off);
    }
    shadow.append(style, card);
    document.body.appendChild(host);
  };

  const onFrame = (ev: MessageEvent) => {
    let frame: Frame;
    try {
      frame = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    if (frame.type === 'moment') show(frame.moment, frame.off === true);
    else if (frame.type === 'clear') hide(frame.id);
    else if (frame.type === 'idle') hide();
  };

  root?.addEventListener('input', onInput);
  document.addEventListener('selectionchange', onSelection);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  const destroy = () => {
    sendWriting();
    stopped = true;
    arriving?.disconnect();
    clearTimeout(settle);
    root?.removeEventListener('input', onInput);
    document.removeEventListener('selectionchange', onSelection);
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    stream?.close();
    stream = null;
    hide();
  };

  // 204 is anyone but the owner, and 403 a page he cannot prove himself on:
  // both stop the page. Anything else is his, even a place the server could
  // not name (a folder's file), and the card shows there all the same.
  // The doc's text arrives after the page opens, so the first view may have
  // none: send one more once the text has settled, then stop watching.
  let arriving: MutationObserver | null = null;
  const awaitText = () => {
    if (!root || passageInView(root) || typeof MutationObserver === 'undefined') return;
    arriving = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (stopped || hidden() || !passageInView(root)) return;
        arriving?.disconnect();
        arriving = null;
        void view();
      }, SCROLL_SETTLE_MS);
    });
    arriving.observe(root, { childList: true, subtree: true, characterData: true });
  };

  void view().then((status) => {
    if (status === 204 || status === 403) return destroy();
    if (stopped) return;
    awaitText();
    if (!opts.openStream && typeof EventSource === 'undefined') return;
    const place = new URLSearchParams({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.workspaceId && opts.docId ? { docId: opts.docId } : {}),
    }).toString();
    const url = place ? `${STREAM_URL}?${place}` : STREAM_URL;
    stream = (opts.openStream ?? ((u) => new EventSource(u)))(url);
    stream.addEventListener('coach', onFrame as EventListener);
  });

  return { destroy };
}
