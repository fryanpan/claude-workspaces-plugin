#!/usr/bin/env bun
/**
 * A doc whose image is wider than its text column, opened on the real doc
 * page in headless Chromium against a real server and the real doc bundle,
 * at 1180x820 and again at 430 wide. MOI's report: an 1800px PNG drew at
 * 1800px against a 1083px column, its computed max-width "none".
 *
 * Spawned by `doc-image-fit-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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

/** The picture's own width, wider than any column the doc page draws. */
export const IMAGE_PX = 1800;

export interface ImageFit {
  /** The window width the page was read at. */
  viewport: number;
  /** The image's natural width, so a picture that never loaded shows as 0. */
  natural: number;
  /** The width it drew at, and the text column's content width. */
  drawn: number;
  column: number;
  maxWidth: string;
}

export interface ImageFitReading {
  wide: ImageFit;
  narrow: ImageFit;
}

const step = (what: string): void => {
  process.stderr.write(`[doc-image-fit-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

/** A grey PNG, `w` by `h`: eight-bit greyscale, one filter byte a row. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const rows = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const READ = `(() => {
  const img = document.querySelector('#editor > .ProseMirror img');
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  const col = img.closest('.ProseMirror');
  const cs = getComputedStyle(col);
  return {
    viewport: window.innerWidth,
    natural: img.naturalWidth,
    drawn: img.getBoundingClientRect().width,
    column: col.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    maxWidth: getComputedStyle(img).maxWidth,
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-image-fit-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const docDir = join(dir, 'harborlight');
    mkdirSync(join(docDir, 'img'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: docDir });
    writeFileSync(join(docDir, 'img', 'wide.png'), png(IMAGE_PX, 120));
    writeFileSync(
      join(docDir, 'ferry.md'),
      '# Harborlight ferry\n\n![The Riverbend crossing](img/wide.png)\n\nSaltmarsh notes below.\n',
    );
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: join(docDir, 'ferry.md'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `doc-image-fit-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const url = `${base}/workspaces/${ws}/docs/${docId}`;
    const readAt = async (width: number, height: number): Promise<ImageFit> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      step(`open the doc at ${width}x${height}`);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      return (await until(`the image loaded at ${width}`, async () =>
        cdp.evaluate(READ),
      )) as ImageFit;
    };
    const wide = await readAt(1180, 820);
    const narrow = await readAt(430, 932);
    cdp.close();
    const reading: ImageFitReading = { wide, narrow };
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
