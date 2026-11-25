/**
 * An app made by `bun run new-app`, its doc page open in headless Chromium,
 * while the doc's owner changes the reader's role twice. The page's role
 * label and its textarea follow each change without a reload, and words the
 * reader typed after the server had already made them view-only never stay
 * on the page and never reach the stored doc.
 *
 * Reported by QA: the label kept saying what the page was first rendered with,
 * and the refused words stayed in the textarea, where the next sync could
 * carry them up once the role was raised again.
 *
 * To type in the gap between the server's role change and the page hearing of
 * it, the page's presence socket (which carries the role) is held by a shim
 * installed before the page runs, then released. Hermetic as
 * `packages/server/test/app-kit-roles.test.ts` is: password sign-in on the
 * app's own SQLite, no Google, no Cloudflare.
 *
 * What the server stored is read by loading the page afresh at the end: a
 * new page holds only what the server kept.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type RunningApp,
  makeBuiltApp,
  postForm,
  signUpVerified,
  startApp,
} from './app-kit-harness.ts';
import { chromeForSuite } from './browser-tests.ts';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from './headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs, extraChromeArgs } from './ui-shot-lib.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A made and built app, two sign-ups, one launch and one page. */
const SUITE_MS = 240_000;
const CASE_MS = 60_000;

/** A sign-up address, built here so no artifact carries one written out. */
const address = (who: string): string => [who, 'example.com'].join('@');

/** Hold the presence socket's frames while `__holdPresence` is set. */
const PRESENCE_HOLD = `(() => {
  const Real = window.WebSocket;
  window.__held = [];
  window.__holdPresence = false;
  window.__loadedAt = Math.random();
  window.WebSocket = class extends Real {
    addEventListener(type, fn, opts) {
      if (type !== 'message' || !String(this.url).endsWith('/presence')) {
        return super.addEventListener(type, fn, opts);
      }
      return super.addEventListener(type, (ev) => {
        if (window.__holdPresence) window.__held.push(() => fn.call(this, ev));
        else fn.call(this, ev);
      }, opts);
    }
  };
  window.__releasePresence = () => {
    window.__holdPresence = false;
    for (const f of window.__held.splice(0)) f();
  };
})()`;

interface PageState {
  label: string;
  readOnly: boolean;
  value: string;
  /** Unchanged since the page loaded: no reload happened. */
  loadedAt: number;
}

const READ = `(() => ({
  label: document.getElementById('role')?.textContent ?? '',
  readOnly: document.getElementById('body').readOnly,
  value: document.getElementById('body').value,
  loadedAt: window.__loadedAt,
}))()`;

async function until<T>(what: string, read: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

describe.skipIf(CHROME === null)('the app kit doc page follows a role change', () => {
  let parent: string;
  let app: RunningApp;
  let browser: Browser | undefined;
  let cdp: Cdp;
  let alice: string;
  const docId = 'riverbend';
  const seen: Record<string, PageState> = {};
  let stored = '';

  const state = async (): Promise<PageState> => (await cdp.evaluate(READ)) as PageState;
  const setRole = async (role: string) => {
    const res = await postForm(
      app.base,
      `/docs/${docId}/roles`,
      { email: address('bob'), role },
      alice,
    );
    if (res.status !== 303) throw new Error(`role ${role}: ${res.status}`);
  };
  const load = async () => {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${app.base}/docs/${docId}` });
    await loaded;
    await until('the page to go live', async () =>
      cdp.evaluate(
        `document.getElementById('status')?.textContent === 'Live' && !document.getElementById('body').disabled`,
      ),
    );
  };
  const type = async (text: string) => {
    await cdp.evaluate(`(() => {
      const box = document.getElementById('body');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    })()`);
    await cdp.send('Input.insertText', { text });
  };

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'app-kit-role-browser-'));
    const appDir = makeBuiltApp(parent, 'harborlight-notes');
    app = await startApp(appDir, join(parent, 'data'));
    alice = await signUpVerified(app, address('alice'), 'Alice');
    const bob = await signUpVerified(app, address('bob'), 'Bob');
    // Alice opens it first, so she owns it.
    const claimed = await fetch(`${app.base}/docs/${docId}`, { headers: { cookie: alice } });
    if (claimed.status !== 200) throw new Error(`claim: ${claimed.status}`);

    browser = await launchChrome(
      CHROME as string,
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile, [...extraChromeArgs()]),
      STARTUP_TIMEOUT_MS,
      `app-kit-role-${process.pid}`,
    );
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    for (const pair of bob.split('; ')) {
      const at = pair.indexOf('=');
      await cdp.send('Network.setCookie', {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        url: app.base,
      });
    }
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRESENCE_HOLD });
    await load();
    seen.first = await state();
    await type('Bob before. ');

    // The owner makes Bob view-only while his page has not heard yet.
    await cdp.evaluate('window.__holdPresence = true');
    await setRole('view');
    await type('Bob refused. ');
    seen.typedUnheard = await state();
    await cdp.evaluate('window.__releasePresence()');
    seen.viewer = await until('the page to hear it is view-only', async () => {
      const s = await state();
      return s.readOnly && !s.value.includes('Bob refused') && s.value.includes('Bob before')
        ? s
        : null;
    }).catch(state);

    await setRole('edit');
    seen.raised = await until('the page to hear it may edit again', async () => {
      const s = await state();
      return !s.readOnly ? s : null;
    }).catch(state);
    await type('Bob after. ');
    await sleep(1_000);
    seen.last = await state();

    await load();
    stored = (await state()).value;
  }, SUITE_MS);

  afterAll(async () => {
    cdp?.close();
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await app?.stop();
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  it(
    'opens as an editor (the control)',
    () => {
      expect(seen.first?.label).toBe('You can edit');
      expect(seen.first?.readOnly).toBe(false);
      // The refused words were typed into a page that still took them.
      expect(seen.typedUnheard?.value).toContain('Bob refused');
    },
    CASE_MS,
  );

  it(
    'says "You can read" and stops taking typing once made view-only, and drops the refused words',
    () => {
      expect(seen.viewer?.label).toBe('You can read');
      expect(seen.viewer?.readOnly).toBe(true);
      expect(seen.viewer?.value).toContain('Bob before');
      expect(seen.viewer?.value).not.toContain('Bob refused');
    },
    CASE_MS,
  );

  it(
    'says "You can edit" and takes typing again once the role is raised, still without them',
    () => {
      expect(seen.raised?.label).toBe('You can edit');
      expect(seen.raised?.readOnly).toBe(false);
      expect(seen.last?.value).toContain('Bob after');
      expect(seen.last?.value).not.toContain('Bob refused');
    },
    CASE_MS,
  );

  it(
    'never reloaded the page',
    () => {
      expect(seen.last?.loadedAt).toBe(seen.first?.loadedAt);
    },
    CASE_MS,
  );

  it(
    'stores the words typed while he could edit, and never the refused ones',
    () => {
      expect(stored).toContain('Bob before');
      expect(stored).toContain('Bob after');
      expect(stored).not.toContain('Bob refused');
    },
    CASE_MS,
  );
});
