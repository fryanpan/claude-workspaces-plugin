#!/usr/bin/env bun
/**
 * Every single-key shortcut, typed into the agent chat's composer on each
 * surface that carries the chat, in headless Chromium against a real server
 * and the real bundles.
 *
 * The chat renders into a shadow root, so a keydown in its textarea reaches a
 * document listener with `target` retargeted to the shadow HOST. A page
 * shortcut that judges "is somebody typing?" by `ev.target` sees no text
 * field and acts: on the front page `e` removed an Incoming Messages line
 * while Bryan typed a word with an e in it.
 *
 * For each surface the driver opens the chat (one tap, cursor in the box),
 * types every shortcut key the way a hardware keyboard sends it (CDP
 * `Input.dispatchKeyEvent`), and reads what the box holds and what the page
 * did. Then, as the control, it takes focus off the chat and presses the
 * surface's own shortcuts on the page, and reads that they still act.
 *
 * Spawned by `typing-shortcuts-browser.test.ts`, which reads the JSON this
 * prints last.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { seedGoals } from '../../server/test/goal-seed.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import {
  AUD,
  OWNER_EMAIL,
  OWNER_HOST,
  TEAM,
  accessKeys,
  edge,
  poll,
  seed,
} from './inbox-front-page.ts';
import { type PageState, SHORTCUT_KEYS, type SurfaceReading } from './typing-shortcuts-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const step = (what: string): void => {
  process.stderr.write(`[typing-shortcuts] ${what}\n`);
};

/** The code and virtual key a US keyboard sends for each key typed. */
const KEY_CODES: Record<string, { code: string; vk: number; shift?: true }> = {
  ' ': { code: 'Space', vk: 32 },
  '?': { code: 'Slash', vk: 191, shift: true },
  Escape: { code: 'Escape', vk: 27 },
};
const keyOf = (key: string) =>
  KEY_CODES[key] ?? { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0) };

async function press(cdp: Cdp, key: string): Promise<void> {
  const k = keyOf(key);
  const text = key.length === 1 ? key : undefined;
  const modifiers = k.shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    modifiers,
  });
}

const SR = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;

/** What a shortcut could have changed, read off the page. */
const READ_STATE = `(() => {
  const shown = (el) => !!el && !el.hidden && !el.classList.contains('hidden') && el.getBoundingClientRect().width > 0;
  const sr = ${SR};
  const box = sr?.querySelector('.lc-compose textarea');
  const a = document.activeElement;
  return {
    href: location.pathname + location.search,
    inboxOpen: document.querySelectorAll('#inbox .inbox-rows > .inbox-row:not(.inbox-cleared)').length,
    inboxCursor: !!document.querySelector('#inbox .inbox-row-cursor'),
    inboxDialog: !!document.querySelector('#inbox [role="dialog"], .inbox-modal'),
    boardRows: document.querySelectorAll('.board-task-row').length,
    rowFocused: !!a?.classList?.contains('board-task-row'),
    helpShown: shown(document.getElementById('board-help')),
    composerValue: box ? box.value : null,
    composerFocused: !!sr && !!box && sr.activeElement === box,
    chatOpen: !!sr && shown(sr.querySelector('.lc-pane')),
  };
})()`;

const state = (cdp: Cdp) => cdp.evaluate(READ_STATE) as Promise<PageState>;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `typing-shortcuts-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // A returning reader, so no name prompt sits over the page.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return cdp;
}

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
}

async function must<T>(what: string, read: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const v = await poll(read, ms);
  if (v === null) throw new Error(`never happened: ${what}`);
  return v;
}

/** Open the page, open the chat with one tap, and put the cursor in its box. */
async function openChat(cdp: Cdp, url: string, ready: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const up = await poll(async () => ((await cdp.evaluate(`!!(${ready})`)) ? true : null), 20_000);
  if (!up) {
    const seen = await cdp.evaluate(
      `location.href + ' | ' + document.body.innerText.slice(0, 600).replace(/\\s+/g, ' ')`,
    );
    throw new Error(`never happened: the page ready (${ready}); the page: ${String(seen)}`);
  }
  const at = await must('the agent button', async () => {
    return (await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-lead-chat="button"]')?.shadowRoot?.querySelector('button');
      const r = b?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
  });
  await tap(cdp, at.x, at.y);
  await must('the chat open with the cursor in its box', async () => {
    const s = await state(cdp);
    if (s.chatOpen && !s.composerFocused) {
      await cdp.evaluate(`${SR}.querySelector('.lc-compose textarea').focus()`);
    }
    return s.chatOpen && s.composerFocused ? true : null;
  });
}

/** The surface's own shortcuts on the page, with nothing editable focused:
 *  the control that says the guard did not simply switch the keys off. */
async function control(cdp: Cdp, keys: readonly string[]): Promise<PageState[]> {
  await cdp.evaluate(`${SR}.activeElement?.blur(); document.activeElement?.blur?.()`);
  const after: PageState[] = [];
  for (const key of keys) {
    await press(cdp, key);
    // A row archive or a removal paints on the next frame or after a fetch.
    await poll(async () => {
      const s = await state(cdp);
      const last = after.at(-1);
      return !last || JSON.stringify(s) !== JSON.stringify(last) ? s : null;
    }, 3000);
    after.push(await state(cdp));
  }
  return after;
}

async function drive(
  cdp: Cdp,
  surface: string,
  url: string,
  ready: string,
  controlKeys: readonly string[],
): Promise<SurfaceReading> {
  step(`${surface}: open the chat`);
  await openChat(cdp, url, ready);
  const before = await state(cdp);
  step(`${surface}: type ${JSON.stringify(SHORTCUT_KEYS.join(''))}`);
  for (const key of SHORTCUT_KEYS) await press(cdp, key);
  // Wait until the box holds as many characters as were typed, or give up
  // and read whatever it does hold: a stolen key never arrives.
  await poll(async () => {
    const s = await state(cdp);
    return (s.composerValue?.length ?? 0) >= SHORTCUT_KEYS.length ? true : null;
  }, 2000);
  // Long enough for a removal's fetch or an archive's repaint to land.
  await new Promise((r) => setTimeout(r, 400));
  const typed = await state(cdp);
  step(`${surface}: control ${JSON.stringify(controlKeys.join(''))}`);
  const controlled = await control(cdp, controlKeys);
  return { surface, before, typed, control: controlled };
}

/** A board whose lead the agent button talks to. */
function boardWithLead(server: ServerHandle): string {
  const ws = server.tasks.createWorkspace('Harborlight').id;
  server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
  server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
  return ws;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'typing-shortcuts-'));
  let handle: ServerHandle | undefined;
  let owner: ServerHandle | undefined;
  let proxy: ReturnType<typeof edge> | undefined;
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
    // Two servers on one build. The front page needs the owner (its inbox is
    // his alone), so it sits behind the stand-in edge that adds his Access
    // assertion. The board pages talk over a socket the edge does not carry,
    // so they go to a plain server directly.
    const ownerData = join(dir, 'owner');
    seed(ownerData);
    const { jwks, assertion } = accessKeys();
    owner = createServer({
      port: 0,
      dataDir: ownerData,
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      cfAccess: { teamDomain: TEAM, audience: AUD, jwks },
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
    });
    const ownerWs = boardWithLead(owner);
    // The front page's agent button talks to the plan board's lead.
    writeFileSync(
      join(ownerData, 'review-plan.json'),
      JSON.stringify({ planWorkspaceId: ownerWs }),
    );
    proxy = edge(`http://127.0.0.1:${owner.port}`, assertion);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const ws = boardWithLead(server);
    const goal = seedGoals(
      server.tasks,
      ws,
      [{ key: 'signup', title: 'Saltmarsh signup' }],
      ALICE,
    ).signup;
    if (!goal) throw new Error('fixture goal refused');
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, unknown>;
    };
    const taskIds: string[] = [];
    for (const title of ['Ship the Saltmarsh signup', 'Answer Riverbend about Thursday']) {
      const made = (await post(`/workspaces/${ws}/tasks`, {
        title,
        body: 'Alice can sign up with an email so that the list reaches her.',
        goal,
        author: ALICE,
      })) as { task: { id: string } };
      taskIds.push(made.task.id);
    }
    const plan = join(dir, 'saltmarsh-plan.md');
    writeFileSync(plan, '# Saltmarsh signup\n\nThe email field is the last one left.\n');
    await post(`/workspaces/${ws}/docs`, {
      docId: 'saltmarsh-plan',
      type: 'markdown',
      sourceUrl: plan,
    });

    const rows = `document.querySelectorAll('.board-task-row').length >= 2`;
    const surfaces: Array<[string, string, string, readonly string[]]> = [
      // `j` puts the cursor on a line, `e` removes it.
      ['front', `${proxy.origin}/`, `document.activeElement?.id === 'inbox'`, ['j', 'e']],
      // `j` focuses a row, `?` shows the key list.
      ['board', `${base}/workspaces/${ws}`, rows, ['j', '?']],
      ['home', `${base}/workspaces/${ws}/home`, `document.readyState === 'complete'`, ['?']],
      // The review editor has no single-key shortcut of its own; nothing to
      // control there beyond the box keeping what was typed.
      [
        'doc',
        `${base}/workspaces/${ws}/docs/saltmarsh-plan`,
        `!!document.querySelector('.ProseMirror')`,
        [],
      ],
      ['task', `${base}/workspaces/${ws}?task=${taskIds[0]}`, rows, ['?']],
    ];
    const cdp = await openBrowser();
    const readings: SurfaceReading[] = [];
    for (const [surface, url, ready, keys] of surfaces) {
      readings.push(await drive(cdp, surface, url, ready, keys));
    }
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ readings })}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    await proxy?.stop();
    await owner?.stop();
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
