#!/usr/bin/env bun
/**
 * The owner changes what a member may do from Board Settings, and the
 * member's open page follows; then a view-only member tries to comment.
 *
 * Two tabs in one headless Chromium, against a real server and the real
 * bundles. The owner's tab is the board on the owner's hostname with the
 * owner's Access token; the member's tab is a doc on the share hostname with
 * theirs. The owner picks a level from the select on a member's row and on
 * the `@domain` row, exactly as a person would; nothing calls the role route
 * except the page. The member's doc page is read for its save-state label,
 * which the socket's access frame sets (`doc-gates.ts`).
 *
 * Spawned by `board-role-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running pages or the
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

export interface BoardRoleReading {
  /** The levels the owner's select offers on a person's row and the domain's. */
  personOptions: string[];
  domainOptions: string[];
  /** Bob, admitted by his own address: his page before and after the owner
   *  picks Can view, the level the server then holds, and the owner's toast. */
  person: { before: string; after: string; server: string | null; toast: string };
  /** Saltmarsh, admitted by `@domain`: the same, for Can comment on the domain row. */
  domain: { before: string; after: string; server: string | null; toast: string };
  /** Bob, now view-only, sends a comment from the doc's composer. */
  refused: { note: string; retry: boolean; kept: string; onServer: boolean };
  /** The control: Saltmarsh, now comment-only, sends one and it lands. */
  allowed: { note: string; onServer: boolean };
}

const SHARE_AUD = 'aud-board-role';
const OWNER_AUD = 'aud-board-role-owner';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
const OWNER_EMAIL = 'owner@example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const BOB = 'bob@harborlight.example';
const SALT = 'saltmarsh@harborlight.example';
const DOMAIN = '@harborlight.example';

const step = (what: string): void => {
  process.stderr.write(`[board-role-driver] ${what}\n`);
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'board-role-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the bundles');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`bundle build failed:\n${built.stderr}`);

    const access = await accessHarness(BOB);
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
    // Bob by his own address, Saltmarsh by the domain: two kinds of row.
    server.shareLinks.addToAudience(ws, [BOB, DOMAIN], 'Harborlight');
    const shareHeaders = async (email: string) => ({
      ...CF_RAY,
      'cf-access-jwt-assertion': await access.signJwt(SHARE_AUD, email),
    });
    for (const email of [BOB, SALT]) {
      const minted = (await local('POST', '/api/share/workspace', { workspaceId: ws })) as {
        link: { linkId: string };
      };
      const redeemed = await fetch(`${base}/s/${minted.link.linkId}`, {
        redirect: 'manual',
        headers: { host: SHARE_HOST, ...(await shareHeaders(email)) },
      });
      if (redeemed.status !== 302) throw new Error(`redeem ${email}: ${redeemed.status}`);
    }

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          ...extraChromeArgs(),
          `--host-resolver-rules=MAP ${SHARE_HOST} 127.0.0.1, MAP ${OWNER_HOST} 127.0.0.1`,
        ]),
      STARTUP_TIMEOUT_MS,
      `board-role-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const member = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    const { targetId } = (await member.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const targets = (await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()) as Array<{
      id: string;
      webSocketDebuggerUrl: string;
    }>;
    const ownerTarget = targets.find((t) => t.id === targetId);
    if (!ownerTarget) throw new Error('the owner’s tab is not listed');
    const owner = await Cdp.connect(ownerTarget.webSocketDebuggerUrl);
    for (const tab of [member, owner]) {
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
      await tab.send('Network.enable');
      await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    }
    await member.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
    });

    const navigate = async (tab: Cdp, url: string): Promise<void> => {
      const loaded = tab.once('Page.loadEventFired');
      await tab.send('Page.navigate', { url });
      await loaded;
    };
    const saveState = async (): Promise<string> =>
      String(await member.evaluate(`document.getElementById('save-state')?.textContent ?? ''`));
    const openDoc = async (email: string, label: string): Promise<void> => {
      await member.send('Network.setExtraHTTPHeaders', { headers: await shareHeaders(email) });
      await navigate(member, `http://${SHARE_HOST}:${port}/workspaces/${ws}/docs/${docId}`);
      await until(`${email}'s doc page to say ${label}`, async () =>
        (await saveState()) === label ? true : null,
      );
    };

    step('the owner opens Board Settings');
    await owner.send('Network.setExtraHTTPHeaders', {
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await access.signJwt(OWNER_AUD, OWNER_EMAIL),
      },
    });
    await navigate(owner, `http://${OWNER_HOST}:${port}/workspaces/${ws}`);
    await until('the settings button', async () =>
      owner.evaluate(`!!document.getElementById('board-settings') || null`),
    );
    await owner.evaluate(`document.getElementById('board-settings').click()`);
    const selectFor = (aria: string) =>
      `document.querySelector(${JSON.stringify(`#board-members-list select[aria-label="${aria}"]`)})`;
    const BOB_SELECT = selectFor(`What ${BOB} can do`);
    const DOMAIN_SELECT = selectFor(`What everyone at ${DOMAIN} can do`);
    await until('the level selects', async () =>
      owner.evaluate(`!!(${BOB_SELECT} && ${DOMAIN_SELECT}) || null`),
    );
    const optionsOf = async (sel: string): Promise<string[]> =>
      (await owner.evaluate(`Array.from(${sel}.options).map((o) => o.textContent)`)) as string[];
    const personOptions = await optionsOf(BOB_SELECT);
    const domainOptions = await optionsOf(DOMAIN_SELECT);
    const toast = async (): Promise<string> =>
      String(await owner.evaluate(`document.getElementById('board-toast')?.textContent ?? ''`));
    const pick = async (sel: string, value: string): Promise<void> => {
      await owner.evaluate(`(() => { const s = ${sel}; s.focus(); s.value = ${JSON.stringify(value)};
        s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    };

    step('Bob’s page is open; the owner picks Can view on his row');
    await openDoc(BOB, 'All changes saved');
    const personBefore = await saveState();
    await pick(BOB_SELECT, 'view');
    await until('Bob’s page to say View only', async () =>
      (await saveState()) === 'View only' ? true : null,
    );
    const personToast = await until('the owner’s toast', async () => (await toast()) || null);
    const person = {
      before: personBefore,
      after: await saveState(),
      server: server.shareLinks.accessRoleOf(ws, BOB),
      toast: personToast,
    };

    step('Saltmarsh’s page is open; the owner picks Can comment on the domain row');
    await openDoc(SALT, 'All changes saved');
    const domainBefore = await saveState();
    await pick(DOMAIN_SELECT, 'comment');
    await until('Saltmarsh’s page to say Comment only', async () =>
      (await saveState()) === 'Comment only' ? true : null,
    );
    const domainToast = await until('the owner’s second toast', async () => {
      const t = await toast();
      return t && t !== personToast ? t : null;
    });
    const domain = {
      before: domainBefore,
      after: await saveState(),
      server: server.shareLinks.accessRoleOf(ws, SALT),
      toast: domainToast,
    };

    /** Select the doc's paragraph, open the composer, and send `text`. */
    const comment = async (text: string): Promise<void> => {
      await member.evaluate(`(() => {
        const p = Array.from(document.querySelectorAll('#editor .ProseMirror p'))
          .find((x) => (x.textContent ?? '').includes('Riverbend notes'));
        const r = document.createRange();
        r.selectNodeContents(p);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      })()`);
      await sleep(200);
      await member.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }))`,
      );
      await until('the composer', async () =>
        member.evaluate(
          `!document.getElementById('composer')?.classList.contains('hidden') || null`,
        ),
      );
      await member.evaluate(`(() => {
        const ta = document.getElementById('composer-text');
        ta.value = ${JSON.stringify(text)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('composer-submit').click();
      })()`);
    };
    const note = async (): Promise<string> =>
      String(
        await member.evaluate(`document.querySelector('#composer .not-sent')?.textContent ?? ''`),
      );
    const onServer = (text: string): boolean =>
      (server.docStore.get(docId)?.ydoc.getMap('threads').toJSON() &&
        JSON.stringify(server.docStore.get(docId)?.ydoc.getMap('threads').toJSON()).includes(
          text,
        )) ??
      false;

    step('Bob, now view-only, sends a comment');
    await openDoc(BOB, 'View only');
    const refusedText = 'Harborlight question from Bob';
    await comment(refusedText);
    const refusedNote = await until('a note on the composer', async () => (await note()) || null);
    const refused = {
      note: refusedNote,
      retry: Boolean(
        await member.evaluate(`!!document.querySelector('#composer .not-sent-retry')`),
      ),
      kept: String(await member.evaluate(`document.getElementById('composer-text')?.value ?? ''`)),
      onServer: onServer(refusedText),
    };

    step('Saltmarsh, comment-only, sends one (the control)');
    await openDoc(SALT, 'Comment only');
    const allowedText = 'Riverbend reply from Saltmarsh';
    await comment(allowedText);
    const landed = await until('the comment to land', async () =>
      onServer(allowedText) ? true : null,
    ).catch(() => false);
    const allowed = { note: await note(), onServer: landed };

    member.close();
    owner.close();
    const reading: BoardRoleReading = {
      personOptions,
      domainOptions,
      person,
      domain,
      refused,
      allowed,
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
