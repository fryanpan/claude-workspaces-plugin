#!/usr/bin/env bun
/**
 * How a task link in the lead's reply shows the task's status, beside how
 * the board's own row for that task shows it, in headless Chromium against a
 * real server and the real bundles, on the board at 1180x820 and 430x932.
 *
 * The board holds two tasks, one in progress and one to do, and the lead's
 * reply links both. At each size the driver reads each task's row on the
 * board — the status element's class and its drawn style — then opens the
 * chat and reads the same from the element beside each link.
 *
 * `CW_SHOT_DIR` set: the chat, open over the board, is saved there as
 * `chat-task-status-<width>.png` at each size.
 *
 * Spawned by `lead-chat-task-status-browser.test.ts`, which reads the JSON it
 * prints.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

/** One status element as drawn: its class and the properties that draw it. */
export interface MarkRead {
  className: string;
  style: Record<string, string>;
}

export interface TaskStatusWidthRun {
  width: number;
  /** Per task status ('in-progress', 'todo'): the board row's element. */
  board: Record<string, MarkRead | null>;
  /** Per task status: the element beside the chat's link to that task. */
  chat: Record<string, MarkRead | null>;
}

export interface TaskStatusRun {
  widths: TaskStatusWidthRun[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-task-status] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-task-status-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return cdp;
}

/** The properties that draw a status element, read the same way on both. */
const READ_MARK = `(el) => {
  if (!el) return null;
  const s = getComputedStyle(el);
  const after = getComputedStyle(el, '::after');
  return {
    className: el.className,
    style: {
      width: s.width,
      height: s.height,
      borderTopWidth: s.borderTopWidth,
      borderTopStyle: s.borderTopStyle,
      borderTopColor: s.borderTopColor,
      borderRadius: s.borderTopLeftRadius,
      backgroundColor: s.backgroundColor,
      afterContent: after.content,
      afterWidth: after.width,
      afterBackground: after.backgroundColor,
    },
  };
}`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const r = btn ? btn.getBoundingClientRect() : null;
  return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

async function click(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-task-status-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the app bundles');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);
    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight', author: ALICE }),
    });
    if (!res.ok) throw new Error(`/workspaces: ${res.status} ${await res.text()}`);
    const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });

    const make = (title: string): string => {
      const made = server.tasks.createTask(ws, {
        title,
        body: 'Alice can see the slipway so that the ferry docks.',
        actor: ALICE,
      });
      if (!made.ok) throw new Error(`the task ${title} was refused`);
      return made.task.id;
    };
    const ids: Record<string, string> = {
      'in-progress': make('Paint the Saltmarsh slipway'),
      todo: make('Moor the Riverbend ferry'),
    };
    const moved = server.tasks.transition(ids['in-progress'] as string, 'in-progress', {
      actor: ALICE,
    });
    if (!moved.ok) throw new Error('the transition was refused');

    const board = `/workspaces/${ws}`;
    const link = (id: string): string => `${base}${board}?task=${id}`;
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    log.append(ws, {
      id: 'ask',
      role: 'person',
      author: ALICE,
      text: 'Where are the Harborlight tasks?',
      ts: t0,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'reply',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: [
        'The two tasks:',
        '',
        `- ${link(ids['in-progress'] as string)}`,
        `- ${link(ids.todo as string)}`,
      ].join('\n'),
      ts: t0 + 1000,
      replyTo: 'ask',
    });

    const shotDir = process.env.CW_SHOT_DIR;
    const widths: TaskStatusWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`board at ${width}`);
      const cdp = await openBrowser(width, height);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${base}${board}` });
      await loaded;
      const boardRead: Record<string, MarkRead | null> = {};
      for (const [status, id] of Object.entries(ids)) {
        boardRead[status] = await until(`the board row for ${status}`, async () => {
          return (await cdp.evaluate(
            `(${READ_MARK})(document.querySelector('.board-task-row[data-task-id="${id}"] .board-status-ctl > span'))`,
          )) as MarkRead | null;
        });
      }

      step(`chat at ${width}`);
      const btn = await until('the agent button', async () => {
        return (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null;
      });
      await click(cdp, btn.x, btn.y);
      const chatRead: Record<string, MarkRead | null> = {};
      for (const [status, id] of Object.entries(ids)) {
        // The element the link carries once its status has landed, whatever
        // it is called: the pill before this branch, the ring after it.
        chatRead[status] = await until(
          `the chat link for ${status}`,
          async () => {
            return (await cdp.evaluate(`(() => {
              const root = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
              const a = [...(root?.querySelectorAll('.lc-msg[data-message-id="reply"] .lc-md a') ?? [])]
                .find((x) => (x.getAttribute('data-ws-link') || x.getAttribute('href') || '').includes('${id}'));
              if (!a || a.hasAttribute('data-ws-pending')) return null;
              return (${READ_MARK})(a.querySelector("span"));
            })()`)) as MarkRead | null;
          },
          8000,
        ).catch(() => null);
      }
      if (shotDir) {
        // The panel's grow has finished, so the picture is the settled one.
        await until('the panel to settle', async () => {
          return (await cdp.evaluate(`(() => {
            const pane = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot?.querySelector('.lc-pane');
            return pane && !pane.hidden && pane.getAnimations().length === 0 ? true : null;
          })()`)) as true | null;
        });
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shotDir, `chat-task-status-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }
      widths.push({ width, board: boardRead, chat: chatRead });
      cdp.close();
    }
    process.stdout.write(`\n${JSON.stringify({ widths } satisfies TaskStatusRun)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 170_000).unref();
await main();
process.exit(0);
