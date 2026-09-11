/**
 * The pages `check:client-boot` loads after the doc page: the two that carry
 * the comment widget. What it judges on each is narrower than on the doc page,
 * on purpose — one copy of Yjs, and a widget that came up — because those are
 * the two things that went wrong, and a board that logs some unrelated error
 * should not be what turns this gate red.
 *
 * ONE COPY OF YJS. Yjs detects a second copy of itself on the page and says so
 * with `console.error('Yjs was already imported…')`. Two copies means two sets
 * of classes, and Yjs relies on `instanceof` to tell its structs apart, so an
 * object made by one copy and handed to the other is misread without an
 * error. Every board load did this until 2026-09-11: the board's bundle
 * carried one copy and the shell also loaded `/widget.esm.js`, which carries
 * its own. No Y object passed between the two — the widget's only surface is
 * strings — but nothing would have stopped the next change from passing one.
 * The count is taken from `Runtime.consoleAPICalled`, which is where Chrome
 * reports `console.error`; the doc check's `Log.entryAdded` does not see it.
 *
 * A WIDGET THAT CAME UP. The board now imports the widget into its own bundle
 * rather than loading it as a second script, so a board whose import never
 * ran would pass the Yjs half with no widget at all. And the widget bundle
 * that other people's pages load is unchanged, so a mockup — a page with no
 * Yjs of its own — is the host page that proves it still works. Up means its
 * socket is open, not just that the element exists.
 */
import type { Cdp, CdpResult } from './headless-chrome.ts';
import { sleep, withTimeout } from './headless-chrome.ts';

export const YJS_DUPLICATE = 'Yjs was already imported';

/** The widget's socket state, painted into its shadow root: `status-open`. */
export const WIDGET_UP_PROBE =
  "!!document.querySelector('claude-feedback-widget')?.shadowRoot?.querySelector('.status-open')";

/** The text of one `Runtime.consoleAPICalled` event, arguments joined. */
export function consoleText(params: CdpResult): string {
  const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>;
  return args
    .map((a) => (typeof a.value === 'string' ? a.value : (a.description ?? String(a.value))))
    .join(' ');
}

/**
 * Counts Yjs's duplicate warning per page. One listener for the whole run,
 * because the CDP client cannot remove one; `page()` names which load the
 * next warnings belong to.
 */
export class YjsWatch {
  private readonly counts = new Map<string, number>();
  private current = '';

  constructor(cdp: Cdp) {
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (!consoleText(p).includes(YJS_DUPLICATE)) return;
      this.counts.set(this.current, this.count(this.current) + 1);
    });
  }

  page(name: string): void {
    this.current = name;
  }

  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

export interface WidgetPageResult {
  name: string;
  url: string;
  /** How many times Yjs said it was loaded twice. */
  yjsDuplicates: number;
  /** The widget's socket opened before the deadline. */
  widgetUp: boolean;
}

/** Load one widget-carrying page and wait, by polling, for the widget. */
export async function loadWidgetPage(
  cdp: Cdp,
  watch: YjsWatch,
  name: string,
  url: string,
  o: { timeoutMs: number; loadTimeoutMs: number },
): Promise<WidgetPageResult> {
  watch.page(name);
  const loaded = cdp.once('Page.loadEventFired');
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw new Error(`navigation to ${name} failed: ${nav.errorText}`);
  await withTimeout(loaded, o.loadTimeoutMs, `${name} load`);
  let widgetUp = false;
  const deadline = Date.now() + o.timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(WIDGET_UP_PROBE)) {
      widgetUp = true;
      break;
    }
    await sleep(100);
  }
  // Yjs warns while its module evaluates, which is before the widget can be
  // up — so by the time the poll has seen the widget, a second copy has
  // already spoken. The beat is for a chunk that arrives after it.
  await sleep(250);
  return { name, url, yjsDuplicates: watch.count(name), widgetUp };
}

/** The lines a failed result prints; empty when the page passed. */
export function widgetPageFailures(r: WidgetPageResult): string[] {
  const out: string[] = [];
  if (r.yjsDuplicates > 0) {
    out.push(
      `❌ ${r.name}: Yjs was imported ${r.yjsDuplicates + 1} times. Two copies on one page break ` +
        "Yjs's instanceof checks; look for a second bundle that carries its own (the widget's is the one that has).",
    );
  }
  if (!r.widgetUp) out.push(`❌ ${r.name}: the comment widget never opened its socket.`);
  return out;
}
