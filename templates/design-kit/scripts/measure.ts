#!/usr/bin/env bun
/**
 * The trial's two numbers.
 *
 * Size: every built file, raw and gzip level 9 (`gzipSync(bytes, { level: 9 })`,
 * the same call scripts/check-widget-size.ts makes). A CLI `gzip -9` reading
 * is not comparable to it.
 *
 * Time to interactive, per page, in a headless Chrome with a cold cache over
 * loopback: from navigation start to the first frame after every kit element
 * on the page is defined and has rendered, or to the end of the last long
 * task if that is later. Median of RUNS loads, at each CPU slowdown. Network
 * is not emulated: CDP's network throttling has been measured off by about
 * 32x in this repo, so no network figure is claimed here.
 *
 *   bun run measure [--runs 7]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DIST, buildKit } from './build.ts';
import { PHONE, launchPage } from './drive.ts';
import { startServer } from './serve.ts';

export function gzip9(bytes: Uint8Array): number {
  return gzipSync(bytes, { level: 9 }).length;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Installed in the page before any script runs; resolves once the kit is ready. */
const PROBE = `(() => {
  window.__longTaskEnd = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__longTaskEnd = Math.max(window.__longTaskEnd, e.startTime + e.duration);
    }
  }).observe({ type: 'longtask', buffered: true });
  addEventListener('DOMContentLoaded', async () => {
    const tags = [...new Set([...document.querySelectorAll('*')]
      .map((e) => e.localName).filter((n) => n.startsWith('wa-')))];
    await Promise.all(tags.map((t) => customElements.whenDefined(t)));
    await Promise.all([...document.querySelectorAll(tags.join(','))].map((e) => e.updateComplete));
    window.__kitDefinedAt = performance.now();
    requestAnimationFrame(() => { window.__kitReadyAt = performance.now(); });
  });
})()`;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

async function main(): Promise<void> {
  const i = process.argv.indexOf('--runs');
  const runs = i > 0 ? Number(process.argv[i + 1]) : 7;
  await buildKit();

  console.log('## Size (gzip level 9)\n\n| file | raw | gzip9 |\n| --- | ---: | ---: |');
  for (const f of files(DIST).sort()) {
    const b = readFileSync(f);
    console.log(`| ${relative(DIST, f)} | ${b.length} | ${gzip9(b)} |`);
  }

  const server = startServer(0);
  const page = await launchPage();
  try {
    await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    console.log(
      `\n## Time to interactive, 430x932 touch, cold cache, loopback, median of ${runs}\n`,
    );
    console.log(
      '| page | CPU | defined ms | first frame ms | last long task ms | TTI ms | worst TTI ms |',
    );
    console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    const CPUS = [1, 4, 6];
    for (const name of ['review-list', 'tasks']) {
      const url = `http://127.0.0.1:${server.port}/t/workspaces/${name}.html`;
      const rows = new Map(
        CPUS.map((c) => [
          c,
          {
            defined: [] as number[],
            ready: [] as number[],
            longEnd: [] as number[],
            tti: [] as number[],
          },
        ]),
      );
      // One discarded load warms the browser process, so the first measured
      // rate does not pay for it. Rates are interleaved run by run, so a
      // change in machine load lands on every rate alike.
      await page.open(url, PHONE);
      await page.waitFor<number>('window.__kitReadyAt', 30_000);
      for (let r = 0; r < runs; r++) {
        for (const cpu of CPUS) {
          await page.open(url, PHONE, { cpuSlowdown: cpu });
          const ready = await page.waitFor<number>('window.__kitReadyAt', 30_000);
          const defined = await page.evaluate<number>('window.__kitDefinedAt');
          const lt = await page.evaluate<number>('window.__longTaskEnd');
          const row = rows.get(cpu);
          row?.defined.push(defined);
          row?.ready.push(ready);
          row?.longEnd.push(lt);
          row?.tti.push(Math.max(ready, lt));
        }
      }
      const fmt = (n: number) => n.toFixed(0);
      for (const [cpu, row] of rows) {
        console.log(
          `| ${name} | ${cpu}x | ${fmt(median(row.defined))} | ${fmt(median(row.ready))} | ${fmt(median(row.longEnd))} | ${fmt(median(row.tti))} | ${fmt(Math.max(...row.tti))} |`,
        );
      }
    }
  } finally {
    await page.close();
    server.stop(true);
  }
}

if (import.meta.main) await main();
