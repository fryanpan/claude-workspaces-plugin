#!/usr/bin/env bun
/**
 * A share-link member's doc page in headless Chromium against a real server
 * and the real doc bundle, at each access level, and across a role change:
 *
 *   - `view` and `comment` members get an editor that takes no typing and a
 *     label where the save state would be; an `edit` member is the control,
 *     and their typing reaches the server.
 *   - An editor whose role is cut to `view` types in the gap before the page
 *     reconnects. The server never takes those words: not when they are typed,
 *     not after the page reconnects as a viewer, not after the owner raises the
 *     role back to `edit`, and not after a reload seeded from this browser's
 *     copy of the doc.
 *
 * The role changes go through the owner's real route, which hangs the
 * member's socket up so it reconnects with the new level. The share hostname
 * resolves to the test server through Chrome's host-resolver rules, and the
 * Access token rides on every request as the header Cloudflare would add.
 *
 * Spawned by `doc-role-lock-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page or the
 * running server.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  extraChromeArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { accessHarness } from '../../server/test/access-share.ts';

/** What one page showed. */
export interface PageView {
  /** `contenteditable` on the editor, as the page reports it. */
  editable: string | null;
  /** The `#save-state` chip's text. */
  label: string;
  /** The crumb's word before the doc's name: "Editing:" or "Reading:". */
  crumb: string;
  /** Whether the words typed into the page are in its editor. */
  typedOnPage: boolean;
  /** Whether the server's doc holds them. */
  typedOnServer: boolean;
}

export interface RoleLockReading {
  view: PageView;
  comment: PageView;
  /** The control: an editor types and the server keeps it. */
  edit: PageView;
  /** Whether the view member's label is on screen at 430px wide, where the
   *  ordinary save state is hidden. */
  viewLabelAt430: boolean;
  /** The editor cut to view, who typed before the reconnect. */
  cut: {
    /** Once the page has reconnected as a viewer. */
    asViewer: PageView;
    /** Once the owner has raised the role back to edit. */
    raised: PageView;
    /** After a reload, from this browser's copy of the doc. */
    reloaded: PageView;
    /** Typing after the raise reaches the server: the page is live again. */
    typesAfterRaise: boolean;
  };
}

const SHARE_AUD = 'aud-doc-role-lock';
const OWNER_AUD = 'aud-doc-role-lock-owner';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
const OWNER_EMAIL = 'owner@example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const VIEWER = 'alice@harborlight.example';
const COMMENTER = 'bob@harborlight.example';
const EDITOR = 'riverbend@harborlight.example';
const CUT = 'saltmarsh@harborlight.example';

const step = (what: string): void => {
  process.stderr.write(`[doc-role-lock-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

let browser: { proc: ChildProcess; profile: string } | undefined;

/**
 * Every editing socket the page opens for the markdown doc, recorded so the
 * driver can type in the gap between a hang-up and the reconnect. Installed
 * before the page runs.
 *
 * Only the markdown doc's socket. The page also opens the board's presence
 * socket and the widget's socket, both under `/y`, and in no fixed order: the
 * widget is its own script. When this logged every `/y` socket, the "latest
 * socket" the driver watched was whichever opened last, and on a loaded CI
 * runner that could be one still connecting when the role was cut. It then
 * opened under the new role, nothing hung it up, and the 30s wait for the
 * hang-up ran out.
 */
const SOCKET_LOG = `(() => {
  const Real = window.WebSocket;
  window.__docSockets = [];
  window.WebSocket = class extends Real {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes('/y?type=markdown')) window.__docSockets.push(this);
    }
  };
  try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
})()`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-role-lock-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const access = await accessHarness(VIEWER);
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const docPath = join(dir, 'ferry.md');
    writeFileSync(docPath, '# Harborlight ferry\n\nRiverbend notes below.\n');
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      ...access.serverOptions,
      cfAccess: { ...access.serverOptions.cfAccess, audience: OWNER_AUD },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
    });
    const server = handle;
    const port = server.port;
    const base = `http://127.0.0.1:${port}`;
    const local = async (method: string, path: string, payload?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await local('POST', '/workspaces', { name: 'Harborlight' })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const docId = String(
      (
        await local('POST', `/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: docPath,
        })
      ).docId,
    );
    await local('POST', `/workspaces/${ws}/docs:attach`, { docId });
    server.shareLinks.addToAudience(ws, ['@harborlight.example'], 'Harborlight');
    const headersFor = async (email: string) => ({
      ...CF_RAY,
      'cf-access-jwt-assertion': await access.signJwt(SHARE_AUD, email),
    });
    const join_ = async (email: string, level: 'view' | 'comment' | undefined) => {
      const minted = (await local('POST', '/api/share/workspace', { workspaceId: ws })) as {
        link: { linkId: string };
      };
      const redeemed = await fetch(`${base}/s/${minted.link.linkId}`, {
        redirect: 'manual',
        headers: { host: SHARE_HOST, ...(await headersFor(email)) },
      });
      if (redeemed.status !== 302) throw new Error(`redeem: ${redeemed.status}`);
      if (!server.shareLinks.setMemberRole(ws, email, 'member', level)) {
        throw new Error(`no member row for ${email}`);
      }
    };
    /** The owner's own browser changing a role, so the socket is hung up. */
    const setRole = async (email: string, role: string) => {
      const res = await fetch(
        `${base}/workspaces/${ws}/members/${encodeURIComponent(email)}/role`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            host: OWNER_HOST,
            ...CF_RAY,
            'x-forwarded-proto': 'https',
            'content-type': 'application/json',
            'cf-access-jwt-assertion': await access.signJwt(OWNER_AUD, OWNER_EMAIL),
            origin: `https://${OWNER_HOST}`,
            'sec-fetch-site': 'same-origin',
          },
          body: JSON.stringify({ role }),
        },
      );
      if (!res.ok) throw new Error(`role ${role}: ${res.status} ${await res.text()}`);
    };
    await join_(VIEWER, 'view');
    await join_(COMMENTER, 'comment');
    await join_(EDITOR, undefined);
    await join_(CUT, undefined);

    const serverText = (): string => {
      const doc = server.docStore.get(docId);
      return doc ? doc.ydoc.getXmlFragment('prose').toString() : '';
    };

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          ...extraChromeArgs(),
          `--host-resolver-rules=MAP ${SHARE_HOST} 127.0.0.1`,
        ]),
      STARTUP_TIMEOUT_MS,
      `doc-role-lock-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_LOG });
    const docUrl = `http://${SHARE_HOST}:${port}/workspaces/${ws}/docs/${docId}`;

    const open = async (email: string): Promise<void> => {
      await cdp.send('Network.setExtraHTTPHeaders', { headers: await headersFor(email) });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: docUrl });
      await loaded;
      await until('the editor', async () =>
        cdp.evaluate(
          `(document.querySelector('#editor .ProseMirror')?.textContent ?? '').includes('Riverbend notes') || null`,
        ),
      );
    };
    /** The page's latest doc socket is open and its access frame is in. */
    const settled = async (label: string): Promise<void> => {
      await until(`the socket to settle (${label})`, async () =>
        cdp.evaluate(
          `(() => { const s = window.__docSockets.at(-1); return s && s.readyState === 1 &&
             (document.getElementById('save-state')?.textContent ?? '') === ${JSON.stringify(label)}; })()`,
        ),
      );
    };
    /** Type `text` at the end of the editor, whatever it allows. */
    const type = async (text: string): Promise<void> => {
      await cdp.evaluate(`(() => {
        const pm = document.querySelector('#editor .ProseMirror');
        pm.focus();
        const r = document.createRange();
        r.selectNodeContents(pm.lastElementChild ?? pm);
        r.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      })()`);
      await cdp.send('Input.insertText', { text });
    };
    const view = async (typed: string): Promise<PageView> => {
      const page = (await cdp.evaluate(`(() => ({
        editable: document.querySelector('#editor .ProseMirror')?.getAttribute('contenteditable') ?? null,
        label: document.getElementById('save-state')?.textContent ?? '',
        crumb: document.querySelector('.doc-crumb .doc-label')?.textContent ?? '',
        typedOnPage: (document.querySelector('#editor .ProseMirror')?.textContent ?? '').includes(${JSON.stringify(typed)}),
      }))()`)) as Omit<PageView, 'typedOnServer'>;
      return { ...page, typedOnServer: serverText().includes(typed) };
    };
    /** Long enough for a typed edit to reach the server, if it is going to. */
    const LAND_MS = 1_500;

    const atLevel = async (email: string, label: string, typed: string): Promise<PageView> => {
      await open(email);
      await settled(label);
      await type(typed);
      await sleep(LAND_MS);
      return view(typed);
    };

    step('a view member');
    const viewer = await atLevel(VIEWER, 'View only', 'Harborlight viewer words');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const viewLabelAt430 = Boolean(
      await cdp.evaluate(`(() => {
        const chip = document.getElementById('save-state');
        return !!chip && chip.getBoundingClientRect().width > 0 && chip.textContent === 'View only';
      })()`),
    );
    if (process.env.ROLE_LOCK_SHOTS) {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(
        join(process.env.ROLE_LOCK_SHOTS, 'view-430.png'),
        Buffer.from(shot.data, 'base64'),
      );
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (process.env.ROLE_LOCK_SHOTS) {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(
        join(process.env.ROLE_LOCK_SHOTS, 'view-1180.png'),
        Buffer.from(shot.data, 'base64'),
      );
    }
    step('a comment member');
    const commenter = await atLevel(COMMENTER, 'Comment only', 'Harborlight commenter words');
    step('an editor, the control');
    const editor = await atLevel(EDITOR, 'All changes saved', 'Harborlight editor words');

    step('an editor whose role is cut to view, typing before the reconnect');
    await open(CUT);
    await settled('All changes saved');
    const sockets = Number(await cdp.evaluate('window.__docSockets.length'));
    await setRole(CUT, 'view');
    await until('the hang-up', async () =>
      cdp.evaluate(`window.__docSockets[${sockets - 1}].readyState === 3 || null`),
    );
    const refusedWords = 'Saltmarsh refused words';
    await type(refusedWords);
    await settled('View only');
    await sleep(LAND_MS);
    const asViewer = await view(refusedWords);

    step('the owner raises the role back to edit');
    await setRole(CUT, 'edit');
    await settled('All changes saved');
    await sleep(LAND_MS);
    const raised = await view(refusedWords);
    const afterWords = 'Saltmarsh words after the raise';
    await type(afterWords);
    const typesAfterRaise = await until(
      'the later words to land',
      async () => serverText().includes(afterWords) || null,
    ).catch(() => false);

    step('a reload, from this browser’s copy');
    await open(CUT);
    await settled('All changes saved');
    await sleep(LAND_MS);
    const reloaded = await view(refusedWords);
    cdp.close();

    const reading: RoleLockReading = {
      view: viewer,
      comment: commenter,
      edit: editor,
      viewLabelAt430,
      cut: { asViewer, raised, reloaded, typesAfterRaise },
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
