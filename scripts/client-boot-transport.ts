/**
 * Telling a slow machine from a broken page, for `check:client-boot`.
 *
 * WHY THIS EXISTS. On 2026-09-11 the check timed out on one Mac for every
 * builder, on main's own sources, while CI passed it. The page was fine: the
 * editor mounted 41ms after the load event. The load event came at 15.4s
 * because `app.js` — 1.4 MB gzipped — took 15.3s to arrive, and Python's
 * http.server moved the same bytes to a Python client on that machine in
 * 10.8s. The loopback transport was running at ~135 KB/s, for every process.
 *
 * So the check reads its verdict from the page and its timing from the wire,
 * and when the wire is slow it measures the same URL again from its own
 * process — a control with no browser in it. Both slow means the machine;
 * only the browser slow means the browser. Either way the failure says which,
 * instead of "page load timed out", which reads as a broken bundle and made
 * every builder learn to wave the check through.
 */

import { get } from 'node:http';

/** One resource as the page's Resource Timing reported it, or the control. */
export interface Transfer {
  url: string;
  /** Bytes on the wire when the browser knows them, else the decoded body. */
  bytes: number;
  ms: number;
  /** False when the budget ran out first: `bytes` is what had arrived. */
  complete?: boolean;
}

/**
 * Below this a loopback transfer is not a page problem. Healthy loopback moves
 * tens of megabytes a second; this is two orders of magnitude under that, and
 * two orders above the ~135 KB/s the incident measured, so neither side of it
 * is close to a real reading.
 */
export const SLOW_LOOPBACK_BYTES_PER_SEC = 1_000_000;

export function bytesPerSec(t: Transfer): number {
  return t.ms > 0 ? (t.bytes * 1000) / t.ms : Number.POSITIVE_INFINITY;
}

export function formatTransfer(t: Transfer): string {
  const kbs = Math.round(bytesPerSec(t) / 1000);
  const cut = t.complete === false ? ' before the budget ran out' : '';
  return `${t.bytes.toLocaleString('en-US')} bytes in ${(t.ms / 1000).toFixed(1)}s${cut} (${kbs} KB/s)`;
}

/** The transfer that cost the most time — the one a slow load is made of. */
export function slowestTransfer(transfers: readonly Transfer[]): Transfer | undefined {
  let worst: Transfer | undefined;
  for (const t of transfers) if (!worst || t.ms > worst.ms) worst = t;
  return worst;
}

/**
 * What to say about a slow load, given the page's slowest transfer and the
 * same URL fetched by the check's own process. `control` is null when the
 * control could not be run, and the verdict says so rather than guessing.
 */
export function transportVerdict(page: Transfer, control: Transfer | null): string[] {
  const lines = [`   slowest: ${page.url}`, `     browser: ${formatTransfer(page)}`];
  if (!control) {
    lines.push('     control: not one byte reached this process, so no verdict.');
    return lines;
  }
  lines.push(`     control (this process, no browser): ${formatTransfer(control)}`);
  const pageSlow = bytesPerSec(page) < SLOW_LOOPBACK_BYTES_PER_SEC;
  const controlSlow = bytesPerSec(control) < SLOW_LOOPBACK_BYTES_PER_SEC;
  if (pageSlow && controlSlow) {
    lines.push(
      '   Both are slow, so this is the machine: its loopback transport, not the page and',
      '   not the browser. CI does not have it. Other loopback-heavy gates on this machine',
      '   will be slow for the same reason.',
    );
  } else if (pageSlow) {
    lines.push(
      '   Only the browser was slow — the server answered this process at full speed.',
      '   Look at the browser (throttling, a stalled renderer) before the bundle.',
    );
  }
  return lines;
}

/**
 * Evaluated in the page: what its Resource Timing says arrived, and every
 * script it names — a script with no entry had not finished arriving.
 */
export const RESOURCE_TIMING_PROBE = `JSON.stringify({
  done: performance.getEntriesByType('resource').map((e) => ({
    url: e.name,
    bytes: e.transferSize || e.encodedBodySize || e.decodedBodySize || 0,
    ms: Math.round(e.responseEnd - e.startTime),
  })),
  scripts: Array.from(document.scripts, (s) => s.src).filter(Boolean),
})`;

/**
 * The transport half of a slow or missing load: the page's slowest transfer
 * against the same URL fetched without a browser. A load that never finished
 * has no timing for the script still arriving, so the control alone speaks
 * for it.
 */
export async function describeTransport(
  transfers: readonly Transfer[],
  pendingScripts: readonly string[],
  budgetMs: number,
): Promise<string[]> {
  const stuck = pendingScripts[0];
  if (stuck) {
    const control = await controlFetch(stuck, budgetMs);
    const lines = [`   still arriving when the page was read: ${stuck}`];
    if (!control) {
      lines.push('     control: not one byte reached this process either — look at the server.');
    } else {
      lines.push(`     control (this process, no browser): ${formatTransfer(control)}`);
      if (bytesPerSec(control) < SLOW_LOOPBACK_BYTES_PER_SEC) {
        lines.push('   The control is slow too, so this is the machine, not the page.');
      }
    }
    return lines;
  }
  const slowest = slowestTransfer(transfers);
  if (!slowest) return ['   the page reported no resource timings.'];
  return transportVerdict(slowest, await controlFetch(slowest.url, budgetMs));
}

/**
 * Re-fetch `url` from this process and time it: the no-browser control.
 *
 * Through `node:http`, which hands over the body as it came off the socket —
 * still gzipped, as the browser received it — so the count is wire bytes, and
 * a control cut off by its budget still reports the rate it was getting.
 * Null when not one byte arrived.
 */
export function controlFetch(url: string, timeoutMs: number): Promise<Transfer | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    let bytes = 0;
    let settled = false;
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      req.destroy();
      resolve(bytes === 0 ? null : { url, bytes, ms: Date.now() - started, complete });
    };
    const req = get(url, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      res.on('end', () => finish(true));
      res.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    const budget = setTimeout(() => finish(false), timeoutMs);
  });
}
