#!/usr/bin/env bun
/**
 * A served mock behind a sign-in that works the way Cloudflare Access does:
 * every request to the board that does not carry the sign-in cookie is
 * refused with a redirect. A real board server sits behind that gate, and
 * headless Chromium opens the mock through it with the cookie set, as a
 * signed-in reader's browser would.
 *
 * The mock's frame has an opaque origin, so a request the frame makes by
 * itself goes out without the cookie and is refused. The frame therefore has
 * to fetch nothing from the board on its own: the widget, the live-update
 * script and the board scripts and stylesheet this mock names are written into
 * its bytes by the server, and voice feedback's script comes through the page
 * holding the frame. The mock reports what worked to its own doc, and the gate
 * reports every request it refused.
 *
 * The control is an image the mock loads from the board, which nothing
 * inlines: its refusal proves the frame's own requests really do go out
 * without the cookie, so an empty list for everything else is the inlining and
 * the relay, not a gate that let the frame through.
 *
 * Spawned by `mock-access.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page and server.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** The gate's cookie, SameSite=Lax like the ones Access and a share session set. */
const ACCESS_COOKIE = 'cw_gate';
const SIGN_IN = '/cdn-cgi/access/login';

export interface AccessReading {
  /** What the frame found working, as it reported to its own doc. */
  report: {
    widget: boolean;
    classic: boolean;
    module: boolean;
    color: string;
    image: number;
    voice: { status?: number; loaded?: boolean; error?: string };
  } | null;
  /** Every request the gate refused: `<sec-fetch-dest> <path>`. */
  refused: string[];
  /** Whether the page holding the frame got through the gate. */
  hostPassed: boolean;
}

/** A 1x1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const MOCK = `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight berths</title>
<link rel="stylesheet" href="/app/harbor.css">
<script src="/app/harbor.js"></script>
<script type="module" src="/app/harbor-mod.js"></script>
</head><body><h1>Harborlight berths</h1><img id="control" src="/app/harbor.png" alt="">
<script>
(async () => {
  const until = async (read) => {
    for (let i = 0; i < 300; i++) { const v = read(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
    return null;
  };
  const widget = await until(() => {
    // Spelled in two halves: the whole name in a mock's script reads to the
    // server as a mock that embeds the widget itself.
    const w = document.querySelector('claude-' + 'feedback-widget');
    return (w && (w.shadow || w.shadowRoot) && (w.shadow || w.shadowRoot).querySelector('.fab')) || null;
  });
  await until(() => window.__harborMod === 1);
  const img = document.getElementById('control');
  await until(() => img.complete);
  const voice = await fetch('/widget/voice.js').then(
    async (r) => ({ status: r.status, loaded: (await r.text()).includes('cwVoice') }),
    (e) => ({ error: String(e) }),
  );
  const report = {
    widget: !!widget,
    classic: window.__harbor === 1,
    module: window.__harborMod === 1,
    color: getComputedStyle(document.querySelector('h1')).color,
    image: img.naturalWidth,
    voice,
  };
  const [, , board, , doc] = location.pathname.split('/');
  await fetch('/workspaces/' + board + '/docs/' + doc + '/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      author: { id: 'anon-reader', kind: 'known', name: 'Reader', color: '#08c' },
      text: 'access:' + JSON.stringify(report),
      anchor: { kind: 'subject' },
    }),
  });
})();
</script></body></html>`;

/** The widget's shipped bundles, built from source into `dist` under their served names. */
async function buildWidget(dist: string): Promise<void> {
  const src = (f: string) => join(import.meta.dirname, '../src', f);
  const built = await Bun.build({
    entrypoints: [
      src('widget-iife.ts'),
      src('mockup-live.ts'),
      src('voice/voice-entry.ts'),
      src('mock-bridge.ts'),
      src('mock-host.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
  renameSync(join(dist, 'voice-entry.js'), join(dist, 'voice.js'));
}

/** Upstream socket for one proxied connection, and what arrived before it opened. */
interface Pipe {
  target: string;
  origin: string | null;
  up: WebSocket | null;
  queue: Array<string | Buffer>;
}

/** Close codes a server may send; anything else becomes a plain close. */
const sendable = (code: number): number =>
  code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code) ? code : 1000;

/** The sign-in gate, in front of the board on `backend`. */
function startGate(backend: number, refused: string[], passed: string[]) {
  return Bun.serve<Pipe>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, server) {
      const u = new URL(req.url);
      const path = `${u.pathname}${u.search}`;
      // The sign-in page itself, which Access serves from its own domain.
      if (u.pathname === SIGN_IN) return new Response('Sign in', { status: 200 });
      const cookies = (req.headers.get('cookie') ?? '').split(/;\s*/);
      if (!cookies.includes(`${ACCESS_COOKIE}=granted`)) {
        refused.push(`${req.headers.get('sec-fetch-dest') ?? '?'} ${u.pathname}`);
        return new Response(null, { status: 302, headers: { location: SIGN_IN } });
      }
      passed.push(path);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const data: Pipe = {
          target: `ws://127.0.0.1:${backend}${path}`,
          origin: req.headers.get('origin'),
          up: null,
          queue: [],
        };
        return server.upgrade(req, { data }) ? undefined : new Response(null, { status: 400 });
      }
      const headers = new Headers(req.headers);
      headers.delete('host');
      headers.delete('accept-encoding');
      const res = await fetch(`http://127.0.0.1:${backend}${path}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
      });
      const out = new Headers(res.headers);
      out.delete('content-encoding');
      out.delete('content-length');
      return new Response(res.body, { status: res.status, headers: out });
    },
    websocket: {
      open(ws) {
        const pipe = ws.data;
        const up = new WebSocket(pipe.target, {
          headers: pipe.origin ? { origin: pipe.origin } : {},
        } as unknown as string[]);
        up.binaryType = 'arraybuffer';
        pipe.up = up;
        up.onopen = () => {
          for (const m of pipe.queue) up.send(m);
          pipe.queue = [];
        };
        up.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
        up.onclose = (e) => ws.close(sendable(e.code), e.reason);
      },
      message(ws, m) {
        const up = ws.data.up;
        if (up?.readyState === WebSocket.OPEN) up.send(m);
        else ws.data.queue.push(m);
      },
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
}

async function poll<T>(what: string, read: () => T | null | undefined): Promise<T | null> {
  for (let i = 0; i < 400; i++) {
    const v = read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  process.stderr.write(`never happened: ${what}\n`);
  return null;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-access-'));
  let handle: ServerHandle | undefined;
  let gate: ReturnType<typeof startGate> | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const app = join(dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'harbor.css'), 'h1{color:rgb(1, 2, 3)}');
    writeFileSync(join(app, 'harbor.js'), 'window.__harbor = 1;');
    writeFileSync(join(app, 'harbor-mod.js'), 'window.__harborMod = 1;');
    writeFileSync(join(app, 'harbor.png'), PNG);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      markdownAppDistDir: app,
      requireSignInToWrite: false,
    });
    const backend = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${backend}${path}`, {
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
    const file = join(dir, 'berths.html');
    writeFileSync(file, MOCK);
    const mock = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'berths', type: 'mockup', sourceUrl: file }))
        .docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });

    const refused: string[] = [];
    const passed: string[] = [];
    gate = startGate(handle.port, refused, passed);
    const front = `http://127.0.0.1:${gate.port}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mock-access-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: ACCESS_COOKIE,
      value: 'granted',
      url: front,
      httpOnly: true,
      sameSite: 'Lax',
    });
    const hostPath = `/workspaces/${ws}/mockups/${mock}`;
    await cdp.send('Page.navigate', { url: `${front}${hostPath}` });
    const thread = await poll('the frame reported to its own doc', () =>
      handle?.docStore.listThreads(mock).find((t) => t.comments[0]?.text.startsWith('access:')),
    );
    const text = thread?.comments[0]?.text;
    const reading: AccessReading = {
      report: text ? (JSON.parse(text.slice('access:'.length)) as AccessReading['report']) : null,
      refused: [...new Set(refused)],
      hostPassed: passed.includes(hostPath),
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    gate?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
