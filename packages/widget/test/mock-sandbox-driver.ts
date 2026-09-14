#!/usr/bin/env bun
/**
 * A hostile mock, served by a real board server into headless Chromium: eight
 * ways its script can try to write to ANOTHER doc as the reader, run from
 * inside the mock's sandboxed frame, and then the same eight run from the page
 * holding the frame, which has the board's own origin.
 *
 * The second run is the control. Every write it lands proves that kind is a
 * real write the server takes from a page that is not sandboxed, so an absence
 * from the first run is the sandbox and the relay refusing it, not a write
 * that could never have landed.
 *
 * The frame's report goes to the mock's OWN doc through the bridge, which is
 * the one write the frame is meant to have — so its arrival also proves the
 * bridge and the host relay work, and carries the relay's stamp.
 *
 * Spawned by `mock-sandbox.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running server.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread } from '@claude-workspaces/core';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
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

/** The reader's display name on the board. Fictional. */
export const READER = 'Sample Reader';

/** The eight kinds of write, each leaving a thread whose text is `<run>:<kind>`. */
export const KINDS = [
  'fetch',
  'xhr-json',
  'xhr-text',
  'beacon',
  'form',
  'socket',
  'worker-fetch',
  'worker-socket',
] as const;

export interface Reading {
  /** What the frame's script saw of each attempt. */
  frame: Record<string, unknown>;
  /** The frame's report as the server stored it: its stamp, and the reader's
   *  name as the frame's storage read it after the host handed it over. */
  report: { via: string | null; name: string | null };
  /** What the same script saw from the host page. */
  control: Record<string, unknown>;
  /** Every comment text on the victim doc, in the end. */
  victim: string[];
}

/**
 * The attack, as plain browser script. `run` names the pass, `victim` is the
 * other doc's id, and `updates` holds
 * the live-socket frames (a Y sync update planting a thread) for each pass.
 */
const ATTACK = `async (run, victim, updates) => {
  const board = location.pathname.split('/')[2];
  const abs = new URL('/workspaces/' + board + '/docs/' + victim + '/threads', location.href).href;
  const wsUrl = abs.replace(/^http/, 'ws').replace(/threads$/, 'y');
  const body = (kind) => JSON.stringify({
    author: { id: 'anon-mallory', kind: 'known', name: 'Mallory', color: '#c00' },
    text: run + ':' + kind,
    anchor: { kind: 'subject' },
  });
  const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
  const out = {};
  const attempt = async (kind, fn) => {
    try { out[kind] = await within(5000, fn()); } catch (e) { out[kind] = 'threw: ' + (e && e.message); }
  };
  const xhr = (type, kind) => new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('POST', abs);
    x.withCredentials = true;
    x.setRequestHeader('content-type', type);
    x.onload = () => resolve(x.status);
    x.onerror = () => resolve('network error');
    x.send(body(kind));
  });
  const socketJs = (url, bytes) => \`new Promise((resolve) => {
    const s = new WebSocket(\${JSON.stringify(url)});
    s.binaryType = 'arraybuffer';
    s.onopen = () => { s.send(new Uint8Array(\${JSON.stringify(bytes)})); s.onmessage = () => { resolve('sent'); s.close(); }; };
    s.onclose = (e) => resolve('closed ' + e.code);
  })\`;
  await attempt('fetch', async () =>
    (await fetch(abs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('fetch') })).status);
  await attempt('xhr-json', () => xhr('application/json', 'xhr-json'));
  await attempt('xhr-text', () => xhr('text/plain', 'xhr-text'));
  await attempt('beacon', async () => navigator.sendBeacon(abs, new Blob([body('beacon')], { type: 'text/plain' })));
  await attempt('form', () => new Promise((resolve) => {
    const name = 'sink-' + run;
    const sink = document.createElement('iframe');
    sink.name = name;
    sink.style.display = 'none';
    sink.onload = () => resolve('loaded');
    document.body.append(sink);
    const f = document.createElement('form');
    f.method = 'POST'; f.action = abs; f.target = name; f.enctype = 'text/plain';
    const i = document.createElement('input');
    const json = body('form');
    i.name = json.slice(0, -1) + ',"x":"';
    i.value = '"}';
    f.append(i);
    document.body.append(f);
    f.submit();
  }));
  await attempt('socket', () => eval(socketJs(wsUrl, updates.socket)));
  const inWorker = (src) => new Promise((resolve) => {
    const w = new Worker(URL.createObjectURL(new Blob(['(async () => postMessage(await (' + src + ')))()'], { type: 'text/javascript' })));
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => resolve('worker error: ' + e.message);
  });
  await attempt('worker-fetch', () => inWorker(\`fetch(\${JSON.stringify(abs)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: \${JSON.stringify(body('worker-fetch'))} }).then((r) => r.status, (e) => 'threw: ' + e.message)\`));
  await attempt('worker-socket', () => inWorker(socketJs(wsUrl, updates['worker-socket'])));
  return out;
}`;

/** A live-socket frame that plants a thread reading `<run>:<kind>` on the victim. */
function plantFrame(run: string, kind: string): number[] {
  const local = new Y.Doc();
  createThread(local, {
    threadId: `th-${run}-${kind}`,
    anchor: { kind: 'subject' },
    createdBy: { id: 'anon-mallory', kind: 'known', name: 'Mallory', color: '#c00' },
    firstComment: { id: `c-${run}-${kind}`, text: `${run}:${kind}` },
  });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(local));
  return [...encoding.toUint8Array(enc)];
}

const updatesFor = (run: string) => ({
  socket: plantFrame(run, 'socket'),
  'worker-socket': plantFrame(run, 'worker-socket'),
});

function hostileHtml(own: string, victim: string): string {
  // The report is the bridge's own-doc write: fetch, aimed at this mock's doc.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight settings</title></head>
<body><h1>Harborlight settings</h1>
<script>
(async () => {
  const results = await (${ATTACK})('frame', '${victim}', ${JSON.stringify(updatesFor('frame'))});
  const board = location.pathname.split('/')[2];
  await fetch('/workspaces/' + board + '/docs/${own}/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      author: { id: 'anon-mallory', kind: 'known', name: 'Mallory', color: '#c00' },
      text: 'report:' + JSON.stringify({ results, name: localStorage.getItem('feedback-user-name') }),
      anchor: { kind: 'subject' },
    }),
  });
})();
</script></body></html>`;
}

/** The two assets the sandbox needs, built from source into `dist`. */
function buildAssets(dist: string): void {
  for (const name of ['mock-bridge', 'mock-host']) {
    const built = spawnSync(
      'bun',
      [
        'build',
        join(import.meta.dirname, '../src', `${name}.ts`),
        '--target=browser',
        '--format=iife',
        `--outfile=${join(dist, `${name}.js`)}`,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`bun build ${name} failed: ${built.stderr}`);
  }
}

async function poll<T>(what: string, read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-sandbox-'));
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'dist');
    buildAssets(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const ids: Record<string, string> = {};
    for (const name of ['hostile', 'victim']) {
      const file = join(dir, `${name}.html`);
      writeFileSync(file, '<!doctype html><html><body><h1>Saltmarsh</h1></body></html>');
      const made = await post(`/workspaces/${ws}/docs`, {
        docId: name,
        type: 'mockup',
        sourceUrl: file,
      });
      ids[name] = String(made.docId);
      await post(`/workspaces/${ws}/docs:attach`, { docId: ids[name] });
    }
    const hostile = ids.hostile ?? '';
    const victim = ids.victim ?? '';
    // A mock is read from its file on every load, so the page can name the
    // ids the server gave both docs.
    writeFileSync(join(dir, 'hostile.html'), hostileHtml(hostile, victim));
    const store = handle.docStore;
    const texts = (docId: string) =>
      store.listThreads(docId).flatMap((t) => t.comments.map((c) => c.text));

    const bin = resolveChromeBin(undefined);
    const b = await launchChrome(
      bin,
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mock-sandbox-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    // The reader's name, stored on the board's origin as a board page stores it.
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/mockups/${victim}` });
    await loaded;
    await cdp.evaluate(`localStorage.setItem('feedback-user-name', ${JSON.stringify(READER)})`);
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/mockups/${hostile}` });

    const reportThread = await poll('the frame reported to its own doc', () =>
      store.listThreads(hostile).find((t) => t.comments[0]?.text.startsWith('report:')),
    );
    const first = reportThread.comments[0];
    const said = JSON.parse(first?.text.slice('report:'.length) ?? '{}') as {
      results: Record<string, unknown>;
      name: string | null;
    };

    const control = (await cdp.evaluate(
      `(${ATTACK})('control', '${victim}', ${JSON.stringify(updatesFor('control'))})`,
    )) as Record<string, unknown>;
    // Wait for the control's writes rather than for a while: the frame's were
    // all sent before the control started, so a frame write still in flight
    // has had longer than these to land. A control that never lands all eight
    // is not an error here; the test names which kind is missing.
    await poll('the control writes landed', () =>
      KINDS.every((k) => texts(victim).includes(`control:${k}`)) ? true : null,
    ).catch(() => null);

    const reading: Reading = {
      frame: said.results,
      report: { via: first?.via ?? null, name: said.name },
      control,
      victim: texts(victim),
    };
    cdp.close();
    // Last line of stdout: the server logs its own lines above it.
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
