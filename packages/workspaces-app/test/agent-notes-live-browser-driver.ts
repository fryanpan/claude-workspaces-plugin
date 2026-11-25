#!/usr/bin/env bun
/**
 * A note no task took reaches a Home page that is ALREADY OPEN, with no
 * reload. Headless Chromium against a real server and the real client build,
 * at 1180x820.
 *
 * The board has Harborlight holding two in-progress tasks and Riverbend
 * holding none. Home is opened first and read empty; then each agent posts an
 * end-of-turn note through the hook's own route, and the driver polls the
 * open page until both agents' groups are drawn. A marker set on `window`
 * before the posts proves the page that shows them is the page that was
 * open, not a reload.
 *
 * Spawned by `agent-notes-live-browser.test.ts`, which reads the JSON this
 * prints on its last line. `CW_SHOT_DIR` set: the page is saved there.
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
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { resetOwnerIdentities } from '../../server/src/actor-identity.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { signedInPerson } from '../../server/test/signed-in-person.ts';

const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };

export interface AgentGroupRead {
  agent: string;
  state: string;
  notes: string[];
}

export interface AgentNotesLiveReading {
  /** The groups drawn before any note was posted. */
  before: AgentGroupRead[];
  /** The groups drawn once both notes were posted, or the last read if the
   *  wait gave out. */
  after: AgentGroupRead[];
  /** The page that drew `after` is the page that was open before the posts. */
  samePage: boolean;
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[agent-notes-live-driver] ${what}\n`);
};

const READ_GROUPS = `[...document.querySelectorAll('.acti-agent-group')].map((g) => ({
  agent: g.dataset.agent,
  state: g.querySelector('.acti-state')?.textContent ?? '',
  notes: [...g.querySelectorAll('.board-activity-note .acti-text')].map((n) => n.textContent),
}))`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-notes-live-'));
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    step('build the client');
    // Its own outdir: two drivers sharing the package's dist delete each
    // other's bundles.
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`client build failed:\n${built.stderr}`);

    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const person = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', leadAgentId: LEAD.id })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    for (const title of ['Wire the tide index', 'Rebuild the quay sidecar']) {
      const { task } = (await post(`/workspaces/${ws}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that sailors plan.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      })) as { task: { id: string } };
      await post(
        `/workspaces/${ws}/tasks/${task.id}/transition`,
        { to: 'todo', author: person.user, workspaceId: ws },
        person.headers,
      );
      await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId: ws,
      });
    }

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `agent-notes-live-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
        .exceptionDetails;
      errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
    });
    const ev = <T>(expr: string) => cdp.evaluate(expr) as Promise<T>;
    // A reader with a name, so the page does not stop at "Who's reviewing?".
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-anon-id', 'alice-reader'); localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const until = async <T>(what: string, read: () => Promise<T | null>, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await read();
        if (v !== null) return v;
        await sleep(50);
      }
      const seen = await ev<string>(
        `location.pathname + ' | ' + document.body.innerText.slice(0, 400).replace(/\\s+/g, ' ')`,
      ).catch(() => 'unreadable');
      throw new Error(`never happened: ${what} — the page: ${seen}`);
    };

    step('open Home');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/home` });
    await withTimeout(loaded, 30_000, 'Home to load');
    await until('the Recent activity pane', async () =>
      (await ev<boolean>(
        `!!document.querySelector('#board-home:not(.hidden) .board-activity-card')`,
      ))
        ? true
        : null,
    );
    // Home's own first read of the list has answered (an empty one).
    await until('Home to read the notes no task took', async () =>
      (await ev<boolean>(
        `performance.getEntriesByType('resource').some((e) => e.name.endsWith('/agent-notes') && e.responseEnd > 0)`,
      ))
        ? true
        : null,
    );
    const before = await ev<AgentGroupRead[]>(READ_GROUPS);
    await ev(`window.__agentNotesLive = 'open-before-posts'`);

    step('post the two notes');
    await post(`/workspaces/${ws}/agents/Harborlight/notes`, {
      kind: 'turn',
      text: 'Both arms green; merged the index half.',
      at: Date.now(),
    });
    await post(`/workspaces/${ws}/agents/Riverbend/notes`, {
      kind: 'turn',
      text: 'Parked on the retention call.',
      at: Date.now(),
    });

    step('wait for the open page to draw them');
    const after = await until('both agents in Not on a task', async () => {
      const groups = await ev<AgentGroupRead[]>(READ_GROUPS);
      return groups.length >= 2 ? groups : null;
    }).catch(() => ev<AgentGroupRead[]>(READ_GROUPS));
    const samePage =
      (await ev<string | undefined>('window.__agentNotesLive')) === 'open-before-posts';
    const shotDir = process.env.CW_SHOT_DIR;
    if (shotDir) {
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(join(shotDir, 'agent-notes-live-1180.png'), Buffer.from(png.data, 'base64'));
    }
    const reading: AgentNotesLiveReading = { before, after, samePage, errors };
    process.stdout.write(`${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    resetOwnerIdentities();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
