#!/usr/bin/env bun
/**
 * An agent marks a comment in progress, then done, on an attached app's page
 * that is already open, in headless Chromium against a real board server.
 *
 * Two comments on one open page, with the comment view open:
 *
 * - `marks`: the agent sends `working`, then `done`, over the REST route the
 *   MCP verb calls. Each time the driver reads the page until the pin and
 *   the card both show the mark, and the time that took.
 * - `stays`: the agent marks the other comment done. The driver reads the
 *   page for `HOLD_MS` and records whether the pin and card were there on
 *   every read; then a person resolves it, and the pin leaves.
 *
 * Spawned by `thread-progress.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page and server.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import {
  Q,
  SHADOW,
  frameSessions,
  frameSurface,
  navigate,
  poll,
  ready,
  step,
  tapUntil,
  typeComment,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** How long the driver reads a page for a mark before calling it lost. */
export const READ_MS = 10_000;
/** How long a done comment is watched for leaving on its own. */
export const HOLD_MS = 3_000;

export interface Shown {
  /** The pin and the card both showed the mark, inside `READ_MS`. */
  shown: boolean;
  /** From the agent's call returning to the page showing it. */
  latencyMs: number;
  /** The words the card's state slot read. */
  word: string | null;
}

export interface Reading {
  working: Shown;
  done: Shown;
  /** Before the hold: the done comment's pin and card were on the page. */
  doneShown: boolean;
  /** On every read during `HOLD_MS`, both were still there. */
  stayed: boolean;
  /** How many reads the hold took. */
  holdReads: number;
  /** After the person resolved it, the pin left. */
  leftAfterResolve: boolean;
  /** Nothing reloaded the page. */
  sameDocument: boolean;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight berths</title></head>
<body><h1 id="title">Harborlight berths</h1>
<p id="one">Riverbend opens at nine.</p>
<p id="two">Saltmarsh ferry runs at ten.</p>
</body></html>`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'thread-progress-'));
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const h = handle;
    const api = `http://127.0.0.1:${h.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const alice = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#cb4d56' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    });
    const docId = 'harborlight-berths';
    const { prefix } = (await post(`/workspaces/${ws}/apps`, {
      docId,
      origin: `http://127.0.0.1:${dev.port}`,
    })) as { prefix: string };

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `thread-progress-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);

    step('open the app');
    await navigate(cdp, `${api}${prefix}`);
    await ready(frame);

    const threadOn = async (id: string): Promise<string> => {
      const text = `Please check ${id}`;
      await typeComment(cdp, frame, text, id);
      await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
      const t = await poll(
        `the comment on ${id} reached the board`,
        () => h.docStore.listThreads(docId).find((x) => x.comments[0]?.text === text) ?? null,
        300,
      );
      return t.id;
    };
    const one = await threadOn('one');
    const two = await threadOn('two');
    const pin = (id: string) => `document.querySelector('.cfw-pin[data-thread-id="${id}"]')`;
    const card = (id: string) => `${SHADOW}?.querySelector('.thread[data-thread-id="${id}"]')`;
    for (const id of [one, two]) {
      await poll(`the pin of ${id} shows`, async () =>
        (await frame.eval(`!!${pin(id)}`)) === true ? true : null,
      );
    }
    await frame.eval(`window.dispatchEvent(new Event('cw-comments'))`);
    await poll('the comment view lists both', async () =>
      (await frame.eval(`!!${card(one)} && !!${card(two)}`)) === true ? true : null,
    );
    await frame.eval('(window.__cwSameDocument = 1)');

    /** Pin and card both wear `state`; the card's word, or null. */
    const wearing = (id: string, state: string) =>
      frame.eval(`(() => {
        const p = ${pin(id)};
        const s = ${card(id)}?.querySelector('.cw-state');
        const on = p?.dataset.state === ${JSON.stringify(state)} && s?.dataset.state === ${JSON.stringify(state)};
        return on ? s.textContent : null;
      })()`) as Promise<string | null>;
    const mark = (id: string, state: string) =>
      post(`/workspaces/${ws}/docs/${docId}/threads/${id}/progress`, { state, author: agent });

    const watchFor = async (id: string, state: string): Promise<Shown> => {
      await mark(id, state);
      const t0 = performance.now();
      while (performance.now() - t0 < READ_MS) {
        const word = await wearing(id, state);
        if (word !== null) {
          return { shown: true, latencyMs: Math.round(performance.now() - t0), word };
        }
        await sleep(25);
      }
      return { shown: false, latencyMs: Math.round(performance.now() - t0), word: null };
    };

    step('the agent starts work, then marks it done');
    const working = await watchFor(one, 'working');
    const done = await watchFor(one, 'done');

    step('a done comment stays until a person resolves it');
    const doneTwo = await watchFor(two, 'done');
    let stayed = doneTwo.shown;
    let holdReads = 0;
    const h0 = performance.now();
    while (stayed && performance.now() - h0 < HOLD_MS) {
      holdReads++;
      if ((await wearing(two, 'done')) === null) stayed = false;
      await sleep(100);
    }
    await post(`/workspaces/${ws}/docs/${docId}/threads/${two}/resolve`, { author: alice });
    let leftAfterResolve = false;
    const r0 = performance.now();
    while (performance.now() - r0 < READ_MS) {
      if ((await frame.eval(`!${pin(two)}`)) === true) {
        leftAfterResolve = true;
        break;
      }
      await sleep(25);
    }

    const reading: Reading = {
      working,
      done,
      doneShown: doneTwo.shown,
      stayed,
      holdReads,
      leftAfterResolve,
      sameDocument: (await frame.eval('window.__cwSameDocument === 1')) === true,
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
