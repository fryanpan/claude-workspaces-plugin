/**
 * What the two follow drivers share: a real server over the real bundles,
 * one board seeded with every kind of place a follow can land, and headless
 * Chromium tabs that hold a follow from their first load.
 *
 * `point-follow-browser-driver.ts` points an agent at each place and follows
 * a person; `follow-voice-browser-driver.ts` reads what a voice message says
 * about where it was said, and whether a spoken answer survives a follow's
 * page change. No real device and no billed engine: a fake listener the
 * driver speaks through, a quiet voice, muted output.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_SPOT_FIELD, type PresenceSpot } from '@claude-workspaces/core/workspace-presence';
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
import { registerOwnerIdentity } from '../../server/src/actor-identity.ts';
import {
  SESSION_COOKIE,
  mintSession,
  sessionKey,
  signSession,
} from '../../server/src/auth/session.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { loadCookieKey } from '../../server/src/share/link-session.ts';
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import { workspaceDocId } from '../../server/src/task-projection.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import { MOCK_PHRASE } from './follow-browser-phrases.ts';

export { MOCK_PHRASE };
export const LEAD = { agentId: 'agent-house-lead', agentName: 'Harborlight' };
export const SIZES = [
  [1180, 820],
  [430, 932],
] as const;

export async function until<T>(
  what: string,
  read: () => Promise<T | null | undefined> | T | null | undefined,
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

const para = (n: number, about: string) =>
  Array.from(
    { length: n },
    (_, i) => `The ${about} note ${i + 1} reads the same as the last.`,
  ).join('\n\n');

/** A doc long enough to scroll: a section in the middle, a phrase at the end. */
export const DOC_MD = `# Quay\n\n${para(18, 'quay')}\n\n## Tides\n\n${para(18, 'tide')}\n\n## Lights\n\n${para(6, 'light')}\n\nThe harbour light turns green at dusk.\n\n${para(18, 'mooring')}\n`;
export const DOC_PHRASE = 'The harbour light turns green at dusk.';
const MOCK_HTML = `<!doctype html><html><head><title>Ferry</title></head><body>${Array.from(
  { length: 60 },
  (_, i) => `<p>Row ${i + 1} of the crossing list.</p>`,
).join('')}<h2 id="ferry">${MOCK_PHRASE}</h2>${Array.from(
  { length: 40 },
  (_, i) => `<p>Sailing ${i + 1} of the day.</p>`,
).join('')}</body></html>`;

export interface Board {
  base: string;
  ws: string;
  taskId: string;
  goalId: string;
  itemKey: string;
  docId: string;
  mockId: string;
  /** Every listener the server opened; `onTurn` is how the driver speaks. */
  opened: TranscriptionOpenOpts[];
  lead: Awaited<ReturnType<typeof agentStream>>;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
  /** The agent's pointer, as `point_at` sends it. */
  point: (place: Record<string, unknown>) => Promise<void>;
  /** Where the server's presence room has a person (`anon-<id>`), or null. */
  spotOf: (userId: string) => PresenceSpot | null;
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];
const browserOf = new WeakMap<Cdp, { proc: ChildProcess; profile: string; port: number }>();

/** The debugging port of the browser a person's page runs in, to open a
 *  second tab in it. */
export const debugPortOf = (cdp: Cdp): number | undefined => browserOf.get(cdp)?.port;
let handle: ServerHandle | undefined;
let dir = '';
let serverBase = '';
/** Each signed-in person's identity id, by the `anonId` a driver gave them. */
const personIds = new Map<string, string>();

/**
 * The id the server puts on a signed-in person's presence and follow chip.
 * The server sets every presence name, so two people on one loopback board
 * are two people only when each proves who they are; an unproven loopback
 * page is the owner. Throws for a person opened without `signIn`.
 */
export function personIdOf(anonId: string): string {
  const id = personIds.get(anonId);
  if (!id) throw new Error(`no signed-in person ${anonId}: open them with signIn: true`);
  return id;
}

/** `extra` adds server options a driver needs, such as `identifyAgentCaller`
 *  so an agent can hold its token. */
export async function bootBoard(
  tag: string,
  extra: Partial<Parameters<typeof createServer>[0]> = {},
): Promise<Board> {
  dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  const widgetDist = join(dir, 'widget');
  await buildWidget(widgetDist);
  const appDist = join(dir, 'app');
  const built = spawnSync(
    'bun',
    ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);
  const opened: TranscriptionOpenOpts[] = [];
  const listener: TranscriptionEngine = {
    name: 'driver',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  const quiet: SpokenVoice = { name: 'quiet', speak: async (_t, out) => out(new Uint8Array(480)) };
  handle = createServer({
    spokenReply: { listener, voices: { 1: quiet, 2: null }, gemini: null } as never,
    port: 0,
    dataDir: join(dir, 'data'),
    widgetDistDir: widgetDist,
    markdownAppDistDir: appDist,
    requireSignInToWrite: false,
    ...extra,
  });
  const server = handle;
  const base = `http://127.0.0.1:${server.port}`;
  serverBase = base;
  const post = async (path: string, payload: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const firstPerson = { id: 'anon-first-person', name: 'Alice', kind: 'known' };
  const ws = (
    (await post('/workspaces', { name: 'Harborlight', author: firstPerson })) as {
      workspace: { id: string };
    }
  ).workspace.id;
  server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
  server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: firstPerson });
  const lead = await agentStream(base, ws, LEAD.agentId);
  const author = { id: LEAD.agentId, name: LEAD.agentName, kind: 'agent' };
  const taskId = (
    (await post(`/workspaces/${ws}/tasks`, {
      title: 'Harborlight tide table',
      body: 'Alice can read the tides so that sailors plan.',
      author,
    })) as { task: { id: string } }
  ).task.id;
  const itemId = (
    (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      review: { shape: 'review', headline: 'Is the Harborlight tide table right?' },
      author,
    })) as { item: { id: string } }
  ).item.id;
  const goal = (await post(`/workspaces/${ws}/goals/add`, {
    title: 'Sailors plan the week',
    author: firstPerson,
  })) as { goal?: { id?: string }; id?: string };
  const goalId = goal.goal?.id ?? goal.id ?? '';
  const file = join(dir, 'quay.md');
  writeFileSync(file, DOC_MD);
  const docId = (
    (await post(`/workspaces/${ws}/docs`, {
      docId: 'quay',
      type: 'markdown',
      sourceUrl: file,
    })) as { docId: string }
  ).docId;
  const mockFile = join(dir, 'ferry.html');
  writeFileSync(mockFile, MOCK_HTML);
  const mockId = (
    (await post(`/workspaces/${ws}/docs`, {
      docId: 'ferry',
      type: 'mockup',
      sourceUrl: mockFile,
    })) as { docId: string }
  ).docId;
  const point = async (place: Record<string, unknown>) => {
    await post(`/workspaces/${ws}/point`, { ...LEAD, ...place });
  };
  const spotOf = (userId: string): PresenceSpot | null => {
    const room = server.docStore.peek(workspaceDocId(ws))?.peekAwareness();
    for (const st of room?.getStates().values() ?? []) {
      const user = st.user as { id?: string } | undefined;
      if (user?.id === userId) return (st[PERSON_SPOT_FIELD] as PresenceSpot | undefined) ?? null;
    }
    return null;
  };
  return {
    base,
    ws,
    taskId,
    goalId,
    itemKey: `task-review:${taskId}:${itemId}`,
    docId,
    mockId,
    opened,
    lead,
    post,
    point,
    spotOf,
  };
}

/**
 * A browser of one person: their own profile, so their identity is their
 * own (`anon-<id>`). `follow` arms a follow from the first load, the way a
 * long-press on a chip leaves it in this tab's session storage.
 */
export async function openPerson(
  width: number,
  height: number,
  who: {
    anonId: string;
    name: string;
    ws: string;
    follow?: string;
    voice?: boolean;
    /** Sign this person in, in their own browser, so the server names them
     *  `name` rather than as the loopback owner (see `personIdOf`).
     *  `'owner'` also makes the identity one of the owner's, for a driver
     *  whose person talks to the lead, which only the owner may. */
    signIn?: boolean | 'owner';
  },
): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) =>
      chromeLaunchArgs({ width, height }, profile, [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
      ]),
    STARTUP_TIMEOUT_MS,
    `follow-${who.anonId}-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  browserOf.set(cdp, b);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const set = (k: string, v: string) =>
    `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`;
  const follow = who.follow
    ? `if (!sessionStorage.getItem('cw-follow:${who.ws}')) sessionStorage.setItem('cw-follow:${who.ws}', ${JSON.stringify(JSON.stringify({ key: who.follow }))});`
    : '';
  if (who.signIn) {
    if (!handle) throw new Error('openPerson signIn: bootBoard first');
    const rec = handle.identities.upsertByEmail(`${who.anonId}@harborlight.example`, {
      displayName: who.name,
    });
    personIds.set(who.anonId, rec.id);
    if (who.signIn === 'owner') registerOwnerIdentity(rec.id);
    const value = signSession(mintSession(rec.id), sessionKey(loadCookieKey(join(dir, 'data'))));
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', { name: SESSION_COOKIE, value, url: serverBase });
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { ${set('feedback-anon-id', who.anonId)} ${set('feedback-user-name', who.name)} ${who.voice ? set('cw.lead-chat.mode', 'voice') : ''} ${follow} } catch {}`,
  });
  return cdp;
}

/**
 * Ends a person's browser. Closing only the debugging socket leaves their tab
 * on the board: it goes on following the lead, and every driver's person
 * speaks as the same local owner, so a tab left from the 1180 round can take
 * the 430 round's spoken answer.
 */
export async function closePerson(cdp: Cdp): Promise<void> {
  cdp.close();
  const browser = browserOf.get(cdp);
  if (browser) await stopBrowser(browser.proc, browser.profile);
}

export async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

export async function tap(cdp: Cdp, at: { x: number; y: number }): Promise<void> {
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

/** The page's address, path and query. */
export const ADDRESS = 'location.pathname + location.search';

/** How far down the doc's scroller is, 0 to 1, and whether `phrase` is in
 *  the middle third of it. */
export const docView = (phrase: string) => `(() => {
  const s = document.getElementById('editor');
  if (!s) return null;
  const room = s.scrollHeight - s.clientHeight;
  const box = s.getBoundingClientRect();
  const el = [...s.querySelectorAll('p, h1, h2, h3')].find((e) => e.textContent.includes(${JSON.stringify(phrase)}));
  const r = el ? el.getBoundingClientRect() : null;
  const third = box.height / 3;
  return {
    scroll: room > 0 ? s.scrollTop / room : 0,
    centred: !!r && r.top >= box.top + third * 0.5 && r.bottom <= box.bottom - third * 0.5,
  };
})()`;

export async function shutdown(): Promise<void> {
  for (const b of browsers) await stopBrowser(b.proc, b.profile);
  await handle?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** A driver that hangs is killed, its browsers with it. */
export function deadline(tag: string, ms: number): void {
  setTimeout(() => {
    process.stderr.write(`[${tag}] gave up after ${ms}ms\n`);
    void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
      process.exit(3),
    );
  }, ms).unref();
}
