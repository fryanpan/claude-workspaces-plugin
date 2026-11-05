/**
 * Two phone readings the Home bar driver takes off a loaded page: which widget
 * controls sit on a tab, and what a text field's blur does in a home-screen app.
 */
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { waitFor } from './wait-for.ts';

type Ev = <T>(expr: string) => Promise<T>;

/** Widget controls whose box meets a tab's, and how many were measured. */
export const overTabs = (ev: Ev) =>
  ev<{ over: string[]; controls: number }>(`(() => {
    const sh = document.querySelector('claude-feedback-widget')?.shadowRoot;
    const found = ['.fab', '.fab-list:not(.fab-mic)', '.fab-mic']
      .map((s) => [s, sh?.querySelector(s)?.getBoundingClientRect()])
      .filter(([, r]) => r && r.width > 0);
    const over = [];
    for (const a of document.querySelectorAll('.home-nav .board-nav-item')) {
      const t = a.getBoundingClientRect();
      for (const [s, r] of found) {
        const meets = r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
        if (meets) over.push(s + ' on ' + a.textContent.trim());
      }
    }
    return { over, controls: found.length };
  })()`);

export interface BlurReading {
  /** The body's style attribute before each change after the blur. */
  styles: string[];
  scrollBefore: number;
  scrollAfter: number;
}

/**
 * Home loaded as a home-screen app, scrolled, with a text field blurred. Only
 * this load says it is standalone, so the driver's other readings are a tab's.
 */
export async function blurInStandalone(
  cdp: Cdp,
  ev: Ev,
  open: () => Promise<void>,
): Promise<BlurReading> {
  const { identifier } = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(navigator, 'standalone', { value: true });`,
  })) as { identifier: string };
  // A background page gets no focus events, and headless Chrome is one.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await open();
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  const scrollBefore = await ev<number>(`(() => {
    window.scrollTo(0, 300);
    const field = document.body.appendChild(document.createElement('textarea'));
    field.focus();
    window.__styles = [];
    new MutationObserver((rows) => {
      for (const row of rows) window.__styles.push(row.oldValue ?? '');
    }).observe(document.body, { attributeOldValue: true, attributeFilter: ['style'] });
    field.blur();
    return window.scrollY;
  })()`);
  const styles = await waitFor(
    async () => {
      const seen = await ev<string[]>('window.__styles');
      return seen.length >= 2 ? seen : null;
    },
    { timeout: 2_000, describe: 'the body to leave layout and come back' },
  ).catch(() => ev<string[]>('window.__styles'));
  return { styles, scrollBefore, scrollAfter: await ev<number>('window.scrollY') };
}
