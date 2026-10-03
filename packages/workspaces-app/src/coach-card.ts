/**
 * The coach on a board or a doc: what the owner is looking at and writing, sent
 * to the server, and the coach's "Hi, I'm noticing…" card when it has
 * something to say.
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
 *
 * The card: calm by default. It sits in the bottom-left corner, does not
 * move or pulse, and stays until he answers it or the server clears it,
 * which it does when he moves to another doc or board. Drawn in a shadow
 * root so neither page's stylesheet reaches it and it adds no rule to either.
 */

const HERE_URL = '/coach/here';
const STREAM_URL = '/coach/stream';
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

type Frame = { type: 'moment'; moment: CoachMomentView } | { type: 'clear'; id: string };

export interface CoachCardOptions {
  workspaceId: string;
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
.cw-coach-acts button { flex: 1 1 0; min-height: 44px; padding: 0 8px; border: 1px solid #d8dee4; border-radius: 6px; background: #fff; color: #1b1f23; font-size: 13.5px; cursor: pointer; }
.cw-coach-acts button:hover { background: #f6f8fa; }
.cw-coach-acts button:disabled { opacity: .55; cursor: default; }
`;

async function defaultPost(url: string, body: unknown): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

  const where = () => ({
    workspaceId: opts.workspaceId,
    ...(opts.docId ? { docId: opts.docId } : {}),
    visible: document.visibilityState !== 'hidden',
  });

  const view = (): Promise<number> => {
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
    if (stopped || !block || !root || !opts.docId) return;
    const text = block.textContent?.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const heading = headingBefore(root, block);
    void post(HERE_URL, { kind: 'wrote', ...where(), ...(heading ? { heading } : {}), text });
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
  const onScroll = () => {
    if (stopped) return;
    clearTimeout(settle);
    settle = setTimeout(() => void view(), SCROLL_SETTLE_MS);
  };
  const onVisibility = () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') sendWriting();
    void view();
  };

  const hide = (id?: string) => {
    if (id && shown?.id !== id) return;
    shown = null;
    host?.remove();
    host = null;
  };

  const answer = async (id: string, value: string, buttons: HTMLButtonElement[]) => {
    for (const b of buttons) b.disabled = true;
    if ((await post(`/coach/moments/${encodeURIComponent(id)}/answer`, { answer: value })) === 200)
      hide(id);
    else for (const b of buttons) b.disabled = false;
  };

  const show = (m: CoachMomentView) => {
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
    const buttons = (
      [
        ['thanks', 'Thanks'],
        ['not-now', 'Not now'],
        ['not-this', 'Not this'],
      ] as const
    ).map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.answer = value;
      b.textContent = label;
      return b;
    });
    for (const b of buttons) {
      b.addEventListener('click', () => void answer(m.id, b.dataset.answer ?? '', buttons));
      acts.appendChild(b);
    }
    card.append(
      line('cw-coach-who', m.name),
      line('cw-coach-line', m.line),
      line('cw-coach-goal', `Your goal: ${m.goal}`),
      acts,
    );
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
    if (frame.type === 'moment') show(frame.moment);
    else if (frame.type === 'clear') hide(frame.id);
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

  // 200 is the owner; anything else (204 for anyone else) stops the page.
  // The doc's text arrives after the page opens, so the first view may have
  // none: send one more once the text has settled, then stop watching.
  let arriving: MutationObserver | null = null;
  const awaitText = () => {
    if (!root || passageInView(root) || typeof MutationObserver === 'undefined') return;
    arriving = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (stopped || !passageInView(root)) return;
        arriving?.disconnect();
        arriving = null;
        void view();
      }, SCROLL_SETTLE_MS);
    });
    arriving.observe(root, { childList: true, subtree: true, characterData: true });
  };

  void view().then((status) => {
    if (status !== 200) return destroy();
    if (stopped) return;
    awaitText();
    if (!opts.openStream && typeof EventSource === 'undefined') return;
    stream = (opts.openStream ?? ((url) => new EventSource(url)))(STREAM_URL);
    stream.addEventListener('coach', onFrame as EventListener);
  });

  return { destroy };
}
