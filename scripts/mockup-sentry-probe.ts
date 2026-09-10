#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * What a mockup's live reload actually sends to Sentry, measured in Chrome.
 *
 * PR 841 made a round that redeclares a top-level `const` RECOVER: the swap
 * retries the colliding script inside a block and the reader still gets the
 * round. What it did not do — and said so in a comment — is stop the browser
 * REPORTING the collision. Chrome fires the script's early error at `window`
 * during evaluation, Sentry's `onerror` handler is registered before the
 * widget ever loads, and so every recovered round filed a
 * `SyntaxError: Identifier 'X' has already been declared`. The project filled
 * with events for a failure the product already handles.
 *
 * A unit test cannot answer this. The question is what leaves the page over
 * the wire, and the three parts that decide it are all real ones: Chrome's
 * global error reporting, the built `sentry.js` with the real SDK in it, and
 * the built `mockup-live.js`. So this probe serves those two bundles to a
 * headless Chrome, drives a real round through the real `EventSource` path,
 * and COUNTS THE ENVELOPES arriving at a fake ingest endpoint of its own.
 *
 * Counting at the endpoint rather than in the page is the point: an in-page
 * `fetch` shim would be bypassed by the SDK's own native-implementation
 * lookup, and a count that cannot count is not a zero. The `unrecovered` arm
 * is the positive control — the same counter, a collision the swap does NOT
 * retry, and an envelope it must see.
 *
 * Run it after `bun run build:widget && bun run build:workspaces-app`:
 *
 *   bun run scripts/mockup-sentry-probe.ts [--port 8803] [--keep]
 *
 * Exit 0 when every arm matched its expectation.
 */
import {
  type Browser,
  Cdp,
  killAndRemove,
  launchChrome,
  pageSocketUrl,
  sleep,
} from './headless-chrome.ts';
import { chromeLaunchArgs, resolveChromeBin, resolveRunId } from './ui-shot-lib.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WS = 'w-probe';
const DOC = 'd-probe';
/** The identifier the real Sentry issues collided on (CLAUDE-WORKSPACES-A). */
const NAME = 'params';
const VIEWPORT = { width: 1180, height: 820 };

/**
 * A round of the mock. `prologue` is a directive line: `"use strict"` makes
 * the script one the swap must NOT retry, which is how the unrecovered half
 * of the contract gets exercised in a real browser.
 */
function round(n: number, prologue = ''): string {
  return (
    `<!doctype html><html><head><title>Round ${n}</title></head>` +
    `<body class="round-${n}"><h1 id="hero">Round ${n}</h1>` +
    '<script>' +
    prologue +
    `const ${NAME} = ['round ${n}'];` +
    `globalThis.onScreen = ${NAME}[0];` +
    '</script></body></html>'
  );
}

/** Round one as the server serves it: Sentry's tags and module, then ours. */
function firstPage(dsn: string): string {
  return round(1)
    .replace(
      '</head>',
      `<meta name="sentry-dsn" content="${dsn}">` +
        '<meta name="sentry-page-type" content="mockup">' +
        '<meta name="sentry-environment" content="probe">' +
        '<script type="module" src="/app/sentry.js"></script>' +
        '</head>',
    )
    .replace(
      '</body>',
      '<script src="/widget/mockup-live.js" data-cw-live ' +
        `data-doc-id="${DOC}" data-workspace-id="${WS}" data-version="1" data-versions="1,2">` +
        '</script></body>',
    );
}

interface Envelope {
  /** `event` for an error, `transaction` for a pageload span, etc. */
  type: string;
  /** The exception type and value, when the item carries one. */
  summary: string;
}

/** Split one envelope body into its items. Header line, then header/payload pairs. */
function readEnvelope(body: string): Envelope[] {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  const out: Envelope[] = [];
  for (let i = 1; i < lines.length; i += 2) {
    let header: { type?: string };
    try {
      header = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!header.type) continue;
    let summary = '';
    try {
      const payload = JSON.parse(lines[i + 1] ?? '{}') as {
        exception?: { values?: Array<{ type?: string; value?: string }> };
        message?: string;
      };
      const v = payload.exception?.values?.[0];
      summary = v ? `${v.type}: ${v.value}` : (payload.message ?? '');
    } catch {
      /* a payload that is not JSON still counts as an item of its type */
    }
    out.push({ type: header.type, summary });
  }
  return out;
}

interface Arm {
  name: string;
  /** Directive line put in front of round two's declaration. */
  prologue: string;
  /** Does the swap recover the collision, so the round lands? */
  recovers: boolean;
}

const ARMS: Arm[] = [
  { name: 'recovered', prologue: '', recovers: true },
  // `"use strict"` takes the script out of the retry (a block's function
  // declarations do not reach the global in strict mode, so wrapping one
  // would take the mock's handlers away). Nothing recovers it, so Sentry must
  // still hear about it — and the counter must see that envelope.
  { name: 'unrecovered', prologue: '"use strict";', recovers: false },
];

interface ArmResult {
  arm: Arm;
  errors: Envelope[];
  others: number;
  hero: string;
  onScreen: string;
}

async function runArm(arm: Arm, port: number, chrome: string): Promise<ArmResult> {
  const errors: Envelope[] = [];
  let others = 0;
  const dsn = `http://probekey@127.0.0.1:${port}/0`;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  let profile = '';
  try {
    server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const p = url.pathname;
        if (p === '/api/0/envelope/') {
          for (const item of readEnvelope(await req.text())) {
            if (item.type === 'event') errors.push(item);
            else others += 1;
          }
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        }
        if (p === '/app/sentry.js' || p === '/widget/mockup-live.js') {
          const file =
            p === '/app/sentry.js'
              ? join(REPO_ROOT, 'packages/workspaces-app/dist/sentry.js')
              : join(REPO_ROOT, 'packages/widget/dist/mockup-live.js');
          return new Response(readFileSync(file, 'utf8'), {
            headers: { 'content-type': 'text/javascript; charset=utf-8' },
          });
        }
        if (p === `/workspaces/${WS}/docs/${DOC}/events:stream`) {
          // One frame, as soon as the page subscribes: `applyUpdateFrame` reads
          // it, sees the reader is not pinned, and fetches round two.
          const body = `event: mockup.updated\ndata: {"version":2,"versions":[{"v":1},{"v":2}]}\n\n`;
          return new Response(body, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          });
        }
        if (p === `/workspaces/${WS}/mockups/${DOC}`) {
          return new Response(round(2, arm.prologue), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        return new Response(firstPage(dsn), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });

    browser = await launchChrome(
      chrome,
      (dir) => {
        profile = dir;
        return chromeLaunchArgs(VIEWPORT, dir);
      },
      30_000,
      resolveRunId(),
      (b) => {
        browser = b;
        profile = b.profile;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await cdp.once('Page.loadEventFired');

    // Poll for the round rather than sleeping on it: the swap happens when the
    // fetch of round two resolves, and that is not a fixed number of ms.
    const deadline = Date.now() + 15_000;
    let hero = '';
    while (Date.now() < deadline) {
      hero = String(await cdp.evaluate("document.querySelector('#hero')?.textContent ?? ''"));
      if (hero === 'Round 2') break;
      await sleep(100);
    }
    // Sentry's transport sends on a queue; give anything already captured its
    // chance to leave before the count is read.
    await sleep(1500);
    const onScreen = String(await cdp.evaluate('String(globalThis.onScreen ?? "")'));
    cdp.close();
    return { arm, errors, others, hero, onScreen };
  } finally {
    killAndRemove(browser?.proc, profile || '/nonexistent');
    server?.stop(true);
  }
}

function parsePort(argv: string[]): number {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : 8803;
}

async function main(): Promise<number> {
  const chrome = resolveChromeBin(undefined);
  const port = parsePort(process.argv.slice(2));
  let bad = 0;
  for (const arm of ARMS) {
    const r = await runArm(arm, port, chrome);
    const redeclarations = r.errors.filter((e) =>
      /already been declared|redeclar/i.test(e.summary),
    );
    console.log(`\n── arm: ${arm.name} ─────────────────────────────`);
    console.log(
      `   #hero: ${JSON.stringify(r.hero)}   globalThis.onScreen: ${JSON.stringify(r.onScreen)}`,
    );
    console.log(`   error envelopes: ${r.errors.length} (${redeclarations.length} redeclaration)`);
    for (const e of r.errors) console.log(`     · ${e.type}: ${e.summary}`);
    console.log(`   other envelopes (transactions, sessions, logs): ${r.others}`);

    if (arm.recovers) {
      if (r.hero !== 'Round 2' || r.onScreen !== 'round 2') {
        console.log('   ❌ the round did NOT recover');
        bad += 1;
      } else if (redeclarations.length > 0) {
        console.log('   ❌ a recovered round still filed to Sentry');
        bad += 1;
      } else if (r.others === 0) {
        // The zero above is only worth reading if this page was reporting at
        // all. A pageload transaction is the proof that Sentry booted, reached
        // the endpoint and was not silenced wholesale by the filter.
        console.log('   ❌ nothing at all reached the endpoint — Sentry never sent,');
        console.log('      so "no error envelope" says nothing about the filter');
        bad += 1;
      } else {
        console.log('   ✅ round recovered, nothing filed (and Sentry was live: see above)');
      }
    } else if (redeclarations.length === 0) {
      console.log('   ❌ an UNRECOVERED collision filed nothing — the filter is too wide,');
      console.log('      or the counter cannot count (this arm is the positive control)');
      bad += 1;
    } else {
      console.log('   ✅ unrecovered collision still filed (counter proven able to count)');
    }
  }
  console.log(bad === 0 ? '\nall arms matched.\n' : `\n${bad} arm(s) did not match.\n`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
