#!/usr/bin/env bun
/**
 * An agent taking the owner's tab somewhere, in headless Chromium against a
 * real server and the real bundles, at 1180x820 and 430x932.
 *
 * The owner has three tabs open on one board: the one in front of them (its
 * window focused), a second tab in the same browser left in the background,
 * and a tab on another device (a second browser whose window is not focused).
 * The agent calls `POST /workspaces/<ws>/person/show` — what `show_person`
 * sends — twice: once to a phrase in a doc, which loads the doc in the front
 * tab, and once to the top of that doc, which scrolls it in place. Each step
 * records where every tab is; the test asserts that only the front one moved.
 *
 * Spawned by `person-navigate-browser.test.ts`, which reads the JSON it prints.
 */
import { registerOwnerIdentity } from '../../server/src/actor-identity.ts';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import {
  ADDRESS,
  DOC_PHRASE,
  LEAD,
  SIZES,
  bootBoard,
  closePerson,
  deadline,
  debugPortOf,
  docView,
  navigate,
  openPerson,
  shutdown,
  until,
} from './follow-browser-kit.ts';

export interface TabAt {
  address: string;
  /** What the page itself reports: visible and focused. */
  attending: boolean;
}

export interface NavigateStep {
  width: number;
  what: string;
  front: TabAt;
  background: TabAt;
  otherDevice: TabAt;
  /** For the doc: the phrase is centred, or the view is at the top. */
  placed: boolean;
}

export interface NavigateRun {
  workspaceId: string;
  docId: string;
  steps: NavigateStep[];
}

const step = (what: string): void => {
  process.stderr.write(`[person-navigate-driver] ${what}\n`);
};

const ATTENDING = `document.visibilityState === 'visible' && document.hasFocus()`;
const BOARD_UP = `!!document.querySelector('#board-people')`;

async function main(): Promise<void> {
  deadline('person-navigate-driver', 200_000);
  let caller: string | null = null;
  const board = await bootBoard('person-navigate', {
    identifyAgentCaller: async () =>
      caller ? { ok: true, agentId: caller, via: 'session' } : { ok: false },
  } as never);
  const { base, ws, docId } = board;
  const B = `/workspaces/${ws}`;
  caller = LEAD.agentId;
  const token = (
    (await (await fetch(`${base}/api/agents/${LEAD.agentId}/token`)).json()) as { token: string }
  ).token;
  const show = async (place: Record<string, unknown>) => {
    const res = await fetch(`${base}${B}/person/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...LEAD, ...place }),
    });
    return res.status;
  };
  const steps: NavigateStep[] = [];
  try {
    for (const [width, height] of SIZES) {
      const owner = `owner${width}`;
      registerOwnerIdentity(`anon-${owner}`);
      step(`owner's tabs at ${width}`);
      const device = await openPerson(width, height, { anonId: owner, name: 'Riverbend', ws });
      const otherDevice = await openPerson(width, height, {
        anonId: owner,
        name: 'Riverbend',
        ws,
      });
      // The front tab: this browser's window holds focus.
      await device.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await navigate(otherDevice, `${base}${B}/home`);
      // A second tab in the same browser, opened first and then left behind.
      const background = device;
      await navigate(background, `${base}${B}/library`);
      await until('the background board', async () =>
        (await background.evaluate(BOARD_UP)) ? true : null,
      );
      const front = await openTab(device, `${base}${B}`, width, height);
      await until('the front board', async () => ((await front.evaluate(BOARD_UP)) ? true : null));
      await until('the server sees the front tab', async () => {
        const st = await fetch(`${base}${B}/person/watch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...LEAD, on: false }),
        });
        const landing = ((await st.json()) as { landing?: { spot?: { path?: string } } }).landing;
        return landing?.spot?.path === B ? true : null;
      });
      const where = async (cdp: Cdp): Promise<TabAt> => ({
        address: String(await cdp.evaluate(ADDRESS).catch(() => '')),
        attending: (await cdp.evaluate(ATTENDING).catch(() => false)) === true,
      });
      const record = async (what: string, placed: boolean) => {
        steps.push({
          width,
          what,
          front: await where(front),
          background: await where(background),
          otherDevice: await where(otherDevice),
          placed,
        });
      };

      step(`to the doc at ${width}`);
      if ((await show({ docId, quote: DOC_PHRASE })) !== 200) throw new Error('show refused');
      await until('the front tab on the doc', async () =>
        (await front.evaluate(ADDRESS).catch(() => null)) === `${B}/docs/${docId}` ? true : null,
      );
      const centred = await until('the phrase centred', async () => {
        const v = (await front.evaluate(docView(DOC_PHRASE)).catch(() => null)) as {
          centred: boolean;
        } | null;
        return v?.centred ? true : null;
      }).catch(() => false);
      await record('doc phrase', centred);

      step(`to the top at ${width}`);
      // The doc page has joined the room; the server must see it attended.
      await until('the server sees the doc page', async () => {
        const st = await fetch(`${base}${B}/person/watch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...LEAD, on: false }),
        });
        const landing = ((await st.json()) as { landing?: { spot?: { docId?: string } } })
          .landing;
        return landing?.spot?.docId === docId ? true : null;
      });
      if ((await show({ docId, scroll: 0 })) !== 200) throw new Error('show refused');
      const top = await until('the doc at its top', async () => {
        const v = (await front.evaluate(docView(DOC_PHRASE)).catch(() => null)) as {
          scroll: number;
        } | null;
        return v && v.scroll < 0.05 ? true : null;
      }).catch(() => false);
      await record('doc top', top);
      front.close();
      await closePerson(device);
      await closePerson(otherDevice);
    }
    const run: NavigateRun = { workspaceId: ws, docId, steps };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    board.lead.close();
    await shutdown();
  }
}

/** A new tab in the browser `cdp` drives, brought to the front at `url`. */
async function openTab(cdp: Cdp, url: string, width: number, height: number): Promise<Cdp> {
  const { Cdp: Client } = await import('../../../scripts/headless-chrome.ts');
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  const port = debugPortOf(cdp);
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    id: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = list.find((t) => t.id === targetId);
  if (!target) throw new Error('new tab not listed');
  const tab = await Client.connect(target.webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await tab.send('Page.bringToFront');
  await navigate(tab, url);
  // The tab behind it no longer holds focus.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return tab;
}

await main();
process.exit(0);
