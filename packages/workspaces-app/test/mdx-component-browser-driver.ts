#!/usr/bin/env bun
/**
 * A bound `.mdx` whose carousel tag imports a declared folder's `.tsx`, which
 * imports an exact-version esm.sh module, holding two `<PlotChart>` slides —
 * opened on the real doc page in headless Chromium against a real server and
 * the real doc bundle, at 1180x820 and at 430 wide. Then the component file
 * is saved with new words and the open page is timed until it shows them.
 *
 * No request leaves the machine: the server's esm.sh fetch is a fake that
 * answers one module, a small custom element standing in for a carousel.
 *
 * Spawned by `mdx-component-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

export interface CarouselReading {
  viewport: number;
  /** Slides the carousel element holds, and how many hold a drawn chart. */
  slides: number;
  charts: number;
  /** The carousel's caption, which the component writes from its props. */
  caption: string;
  /** The carousel's width against the text column's. */
  width: number;
  column: number;
}

export interface ComponentReading {
  wide: CarouselReading;
  narrow: CarouselReading;
  /** The caption after the component file was saved, and how long it took
   *  from the save to the page showing it. */
  afterSave: string;
  saveToPageMs: number;
}

const step = (what: string): void => {
  process.stderr.write(`[mdx-component-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** The fake esm.sh module: a custom element that lays its children out as slides. */
const SLIDES_MODULE = `
class HlCarousel extends HTMLElement {
  connectedCallback() { this.style.display = 'block'; }
}
customElements.define('hl-carousel', HlCarousel);
export const version = '1.0.0';
`;

const CAROUSEL = (
  caption: string,
) => `import { version } from 'https://esm.sh/harborlight-slides@1.0.0';

export default function mount(el: HTMLElement, props: { label: string; children: Node[] }) {
  const carousel = document.createElement('hl-carousel');
  for (const child of props.children) {
    const slide = document.createElement('section');
    slide.className = 'slide';
    slide.append(child);
    carousel.append(slide);
  }
  const caption = document.createElement('p');
  caption.className = 'caption';
  caption.textContent = \`${caption} \${props.label} v\${version}\`;
  el.append(carousel, caption);
}
`;

const DOC = `# Harborlight ferry

import Carousel from './components/carousel.tsx'

<Carousel label="Riverbend">
  <PlotChart subtitle="Harborlight crossings" data={{ rows: [{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 4 }] }} marks={[{ mark: "lineY", data: "rows", options: { x: "x", y: "y" } }]} />
  <PlotChart subtitle="Saltmarsh crossings" data={{ rows: [{ x: 1, y: 3 }, { x: 2, y: 1 }, { x: 3, y: 6 }] }} marks={[{ mark: "barY", data: "rows", options: { x: "x", y: "y" } }]} />
</Carousel>

Riverbend notes below.
`;

const READ = `(() => {
  const host = document.querySelector('#editor .mdx-live');
  const carousel = host && host.querySelector('hl-carousel');
  if (!carousel) return null;
  const slides = carousel.querySelectorAll(':scope > section.slide');
  const charts = carousel.querySelectorAll(':scope > section.slide .mdx-plot svg');
  if (charts.length < slides.length) return null;
  const col = host.closest('.ProseMirror');
  const cs = getComputedStyle(col);
  return {
    viewport: window.innerWidth,
    slides: slides.length,
    charts: charts.length,
    caption: host.querySelector('.caption')?.textContent ?? '',
    width: carousel.getBoundingClientRect().width,
    column: col.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mdx-component-'));
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
    const repo = join(dir, 'harborlight');
    mkdirSync(join(repo, 'components'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'components', 'component.json'), '{}');
    writeFileSync(join(repo, 'components', 'carousel.tsx'), CAROUSEL('Ferry'));
    writeFileSync(join(repo, 'ferry.mdx'), DOC);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      componentFetch: async (url) =>
        url.startsWith('https://esm.sh/harborlight-slides@1.0.0')
          ? new Response(SLIDES_MODULE)
          : new Response('not here', { status: 404 }),
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
          sourceUrl: join(repo, 'ferry.mdx'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mdx-component-${process.pid}`,
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
    const readAt = async (width: number, height: number): Promise<CarouselReading> => {
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
      return (await until(`the carousel drew at ${width}`, async () =>
        cdp.evaluate(READ),
      )) as CarouselReading;
    };
    const narrow = await readAt(430, 932);
    const wide = await readAt(1180, 820);

    step('save the component file and time the open page');
    const file = join(repo, 'components', 'carousel.tsx');
    const savedAt = performance.now();
    writeFileSync(file, CAROUSEL('Ferry rebuilt'));
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const afterSave = (await until('the saved component on the open page', async () => {
      const r = (await cdp.evaluate(READ)) as CarouselReading | null;
      return r?.caption.startsWith('Ferry rebuilt') ? r.caption : null;
    })) as string;
    const saveToPageMs = Math.round(performance.now() - savedAt);
    cdp.close();
    const reading: ComponentReading = { wide, narrow, afterSave, saveToPageMs };
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
