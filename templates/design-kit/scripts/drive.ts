/**
 * A headless Chrome for the trial, on the repo's own launcher: throwaway
 * profile, no window anyone can see, cleaned up on close. The test and the
 * measuring script both drive pages through this.
 */
import { writeFileSync } from 'node:fs';
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

export interface Viewport {
  width: number;
  height: number;
  /** Phone emulation: touch events, a coarse pointer, mobile viewport rules. */
  mobile: boolean;
}

export const IPAD: Viewport = { width: 1180, height: 820, mobile: false };
export const PHONE: Viewport = { width: 430, height: 932, mobile: true };

export interface Page {
  cdp: Cdp;
  open(url: string, viewport: Viewport, opts?: { cpuSlowdown?: number }): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** Poll until `expression` is truthy; returns its value. */
  waitFor<T>(expression: string, timeoutMs?: number): Promise<T>;
  tap(x: number, y: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchPage(chrome = resolveChromeBin(undefined)): Promise<Page> {
  const browser = await launchChrome(
    chrome,
    (profile) => chromeLaunchArgs({ width: IPAD.width, height: IPAD.height }, profile),
    STARTUP_TIMEOUT_MS,
    `design-kit-${process.pid}`,
  );
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async <T>(expression: string): Promise<T> =>
    (await cdp.evaluate(expression)) as T;

  const waitFor = async <T>(expression: string, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate<T>(expression);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
      await sleep(50);
    }
  };

  return {
    cdp,
    evaluate,
    waitFor,
    async open(url, viewport, opts = {}) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });
      await cdp.send(
        'Emulation.setTouchEmulationEnabled',
        viewport.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
      );
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpuSlowdown ?? 1 });
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    },
    async tap(x, y) {
      const point = [{ x, y, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    async screenshot(path) {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
    },
    async close() {
      cdp.close();
      await stopBrowser(browser.proc, browser.profile);
    },
  };
}

/** Every kit tag on the page is defined and has rendered once. */
export const KIT_READY = `(async () => {
  const tags = [...new Set([...document.querySelectorAll('*')]
    .map((e) => e.localName).filter((n) => n.startsWith('wa-')))];
  if (tags.length === 0) return false;
  await Promise.all(tags.map((t) => customElements.whenDefined(t)));
  await Promise.all([...document.querySelectorAll(tags.join(','))].map((e) => e.updateComplete));
  return true;
})()`;
