/**
 * The page half of `draft-reload-driver.ts`: what the reader types, what a
 * page shows of it, and the taps and reads that drive it over CDP, in the page
 * or inside the sandboxed frame. Every value comes from the running page.
 */
// audit: no-text
import { type Cdp, sleep } from '../../../scripts/headless-chrome.ts';

export const HEADING = 'Harborlight Street Projects';
export const LEDE = 'Riverbend opens at nine.';
export const EDITED = 'Riverbend opens at ten.';
export const COMMENT = 'Saltmarsh ferry should be first';

/** What a page shows of the reader's unsent work. */
export interface Shown {
  /** Comment mode is on. */
  mode: boolean;
  /** A composer is open. */
  open: boolean;
  /** Its words. */
  text: string | null;
  /** What it says it is on: the anchor's element's words. */
  on: string | null;
  /** The paragraph's words as the page shows them. */
  lede: string | null;
  /** Orange bars on the page: unsent edits, and sent ones not applied. */
  bars: number;
}

export interface Reading {
  /** Before any reload, as typed. */
  typed: Record<'app' | 'mock' | 'plain', Shown>;
  /** After the app's dev server reloaded its frame. */
  appReloaded: Shown;
  /** After the reader reloaded the mock's page. */
  mockReloaded: Shown;
  /** After the agent wrote the mock's next round, swapped in place. */
  mockSwapped: Shown & { roundTwo: boolean };
  /** After the plain page reloaded. */
  plainReloaded: Shown;
  /** The plain page's dev server at another path, while a draft waits on the first. */
  plainOtherPage: Shown;
  /** The app door after posting the restored comment and reloading. */
  afterPost: Shown & { posted: boolean };
  /** The app door after typing a comment, cancelling it and reloading. */
  afterCancel: Shown;
  /** The app door after sending the edits and reloading: the unsent count in edit mode. */
  afterSend: { sent: boolean; unsent: number | null };
}

export const TAG = 'claude-feedback-widget';

export const step = (what: string): void => {
  process.stderr.write(`[draft-reload-driver] ${what}\n`);
};

export async function poll<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  tries = 200,
): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** Where the page's own content is evaluated: the page, or the sandboxed frame. */
export interface Surface {
  eval(expr: string): Promise<unknown>;
  offset(): Promise<{ x: number; y: number }>;
}

export function pageSurface(cdp: Cdp): Surface {
  return { eval: (e) => cdp.evaluate(e), offset: async () => ({ x: 0, y: 0 }) };
}

export function frameSurface(cdp: Cdp, sessions: string[]): Surface {
  const inFrame = async (expression: string): Promise<unknown> => {
    for (const sessionId of [...sessions]) {
      const r = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => { if (!document.getElementById('title')) return '__none__'; return (${expression}); })()`,
            returnByValue: true,
            awaitPromise: true,
          },
          sessionId,
        )
        .catch(() => null)) as { result?: { value?: unknown } } | null;
      const v = r?.result?.value;
      if (v !== '__none__' && r) return v;
    }
    return null;
  };
  return {
    eval: inFrame,
    offset: async () =>
      (await cdp.evaluate(
        `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
      )) as { x: number; y: number },
  };
}

export async function frameSessions(cdp: Cdp): Promise<string[]> {
  const sessions: string[] = [];
  cdp.on('Target.attachedToTarget', (p) => {
    const sessionId = p.sessionId as string;
    if ((p.targetInfo as { type?: string } | undefined)?.type === 'iframe') {
      sessions.push(sessionId);
    }
    void cdp
      .send('Runtime.enable', {}, sessionId)
      .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId))
      .catch(() => {});
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const i = sessions.indexOf(p.sessionId as string);
    if (i >= 0) sessions.splice(i, 1);
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return sessions;
}

export async function centre(s: Surface, find: string): Promise<{ x: number; y: number } | null> {
  const r = (await s.eval(
    `(() => { const e = ${find}; if (!e) return null; const b = e.getBoundingClientRect(); if (!b.width) return null; return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  )) as { x: number; y: number } | null;
  if (!r) return null;
  const o = await s.offset();
  return { x: r.x + o.x, y: r.y + o.y };
}

export async function tap(cdp: Cdp, s: Surface, find: string, what: string): Promise<void> {
  const at = await poll(what, () => centre(s, find));
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

/** Tap `find` until `done` reads true. The first tap after a frame loads can
 *  reach nothing (`edit-mode-driver.ts` measured it); a second always lands. */
export async function tapUntil(
  cdp: Cdp,
  s: Surface,
  find: string,
  done: string,
  what: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await tap(cdp, s, find, what);
    for (let i = 0; i < 40; i++) {
      if (await s.eval(`!!(${done})`)) return;
      await sleep(50);
    }
    step(`tap ${attempt} on ${what} changed nothing`);
  }
  throw new Error(`never happened: ${what}`);
}

export const SHADOW = `document.querySelector('${TAG}')?.shadowRoot`;
export const Q = (sel: string) => `${SHADOW}?.querySelector(${JSON.stringify(sel)})`;

export const SHOWN = `(() => {
  const w = document.querySelector('${TAG}');
  const s = w?.shadowRoot;
  const c = s?.querySelector('.composer');
  return {
    mode: !!w?.feedbackMode,
    open: !!c,
    text: c?.querySelector('textarea')?.value ?? null,
    on: c?.querySelector('.composer-snippet b')?.textContent ?? null,
    lede: document.getElementById('lede')?.textContent?.trim() ?? null,
    bars: [...document.querySelectorAll('.cfw-edit-bar')].filter((b) => !b.classList.contains('applied')).length,
  };
})()`;

export async function read(s: Surface, want: (x: Shown) => boolean): Promise<Shown> {
  let last: Shown | null = null;
  try {
    return await poll(
      'the page settled',
      async () => {
        last = (await s.eval(SHOWN)) as Shown | null;
        return last && want(last) ? last : null;
      },
      100,
    );
  } catch {
    return last ?? { mode: false, open: false, text: null, on: null, lede: null, bars: 0 };
  }
}

/** Wait for the widget's buttons, and for the pencil beside them. */
export async function ready(s: Surface): Promise<void> {
  await poll('the widget and its pencil', () =>
    s.eval(`!!${Q('.fab')} && !!${Q('.fab-edit')}`).then((v) => (v ? true : null)),
  );
}

export async function editLede(cdp: Cdp, s: Surface): Promise<void> {
  await tapUntil(cdp, s, Q('.fab-edit'), Q('.cw-edit-banner'), 'the pencil');
  await tap(cdp, s, `document.getElementById('lede')`, 'the paragraph');
  await poll('the paragraph is being edited', () =>
    s.eval(`document.getElementById('lede').isContentEditable`).then((v) => (v ? true : null)),
  );
  await s.eval(`document.execCommand('selectAll')`);
  await cdp.send('Input.insertText', { text: EDITED });
  await poll('the paragraph shows the new words', () =>
    s
      .eval(`document.getElementById('lede').textContent.trim()`)
      .then((v) => (v === EDITED ? true : null)),
  );
  // Leave edit mode, unsent: the words wait on the page.
  await tap(cdp, s, Q('.cw-edit-banner .picker-cancel'), 'edit mode Done');
  await poll('edit mode is off', () =>
    s.eval(`!${Q('.cw-edit-banner')}`).then((v) => (v ? true : null)),
  );
}

/** Comment on `id`. A second comment goes on another element: the first
 *  one's pin stands where its tap landed. */
export async function typeComment(cdp: Cdp, s: Surface, text: string, id = 'title'): Promise<void> {
  await tapUntil(cdp, s, Q('.fab'), Q('.picker-banner'), 'the comment button');
  await tapUntil(
    cdp,
    s,
    `document.getElementById('${id}')`,
    `${Q('.composer textarea')} && ${SHADOW}.activeElement === ${Q('.composer textarea')}`,
    'the heading',
  );
  await cdp.send('Input.insertText', { text });
  await poll('the composer holds the words', () =>
    s.eval(`${Q('.composer textarea')}?.value`).then((v) => (v === text ? true : null)),
  );
}

export async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

/** Mark the surface's document, so a reload is seen as the mark going. */
export async function markDocument(s: Surface): Promise<void> {
  await s.eval('(window.__cwBefore = 1)');
}

export async function reloaded(s: Surface): Promise<void> {
  await poll(
    'the page reloaded',
    () => s.eval('window.__cwBefore === undefined').then((v) => (v === true ? true : null)),
    400,
  );
}
