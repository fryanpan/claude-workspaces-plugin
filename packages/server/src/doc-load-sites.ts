/**
 * Who brought each doc into memory.
 *
 * `residentBy` says what keeps a resident doc; it cannot say what loaded it,
 * and a resident count that jumps by thousands in one window is a question
 * about the loader. `DocStore` records one site per doc that enters its map
 * (a hydrate from disk or a create), and the `[doc-store] mem` line prints
 * the window's busiest sites as `loaded=+N by=<site>*n,…`.
 *
 * The site is read off the stack: the first frame outside `doc-store.ts`,
 * as `packages/<path>:<line>` — the same shape the binding activations use
 * (`activationTag` in `file-binding.ts`). One stack capture per doc LOADED,
 * not per read: a resident doc is answered before anything here runs, and a
 * load already decodes a `.ydoc`, which costs more than the capture.
 *
 * Relative to `packages/` on purpose: the string is served by
 * `GET /api/metrics`, and an absolute path is a host-machine fact.
 */

/** Distinct sites kept; everything past the cap folds into `other`. */
export const LOAD_SITE_CAP = 32;

/** Frames deep enough to climb out of the lifecycle's own call chain
 *  (`resolveDoc` → `hydrateDoc` → `getOrCreate`, plus the forwarders). */
const STACK_FRAMES = 24;

/** The first frame of `stack` outside `doc-store.ts`, as
 *  `packages/<path>:<line>`; `external` when no frame is under `packages/`. */
export function loadSiteOf(stack: string | undefined): string {
  if (!stack) return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/[/\\]packages[/\\]([^\s)]+?):(\d+):\d+/);
    if (!m) continue;
    const where = (m[1] ?? '').replace(/\\/g, '/');
    if (where.endsWith('/doc-store.ts') || where.endsWith('/doc-load-sites.ts')) continue;
    return `packages/${where}:${m[2]}`;
  }
  return 'external';
}

/** The current call's load site. */
export function currentLoadSite(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    return loadSiteOf(new Error().stack);
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Since-boot load counts by site. */
export class DocLoadSites {
  private readonly counts = new Map<string, number>();
  private total = 0;

  constructor(private readonly site: () => string = currentLoadSite) {}

  /** One doc entered memory, from wherever the stack says. */
  record(): void {
    this.total += 1;
    const tag = this.site();
    const seen = this.counts.get(tag);
    if (seen !== undefined) {
      this.counts.set(tag, seen + 1);
    } else if (this.counts.size >= LOAD_SITE_CAP) {
      this.counts.set('other', (this.counts.get('other') ?? 0) + 1);
    } else {
      this.counts.set(tag, 1);
    }
  }

  /** Every site (at most `LOAD_SITE_CAP` plus `other`), busiest first, and
   *  the total. All of them, so a reader's window delta is exact. */
  stats(): { loads: { tag: string; count: number }[]; loadsTotal: number } {
    return {
      loads: [...this.counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([tag, count]) => ({ tag, count })),
      loadsTotal: this.total,
    };
  }
}

/** How many sites the mem line names. */
export const LOAD_SITES_PRINTED = 5;

/**
 * The window between two `stats()` reads: loads since `previous`, and the
 * sites that grew, busiest first. `previous` null means since boot.
 */
export function loadsInWindow(
  current: { loads: { tag: string; count: number }[]; loadsTotal: number },
  previous: ReadonlyMap<string, number> | null,
  previousTotal: number,
): { loaded: number; by: { tag: string; count: number }[] } {
  const by: { tag: string; count: number }[] = [];
  for (const { tag, count } of current.loads) {
    const delta = count - (previous?.get(tag) ?? 0);
    if (delta > 0) by.push({ tag, count: delta });
  }
  by.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
  return { loaded: Math.max(0, current.loadsTotal - previousTotal), by };
}

/** ` loaded=+N by=site*n,…` — `by=none` for a window that loaded nothing. */
export function formatLoads(w: { loaded: number; by: { tag: string; count: number }[] }): string {
  const shown = w.by.slice(0, LOAD_SITES_PRINTED);
  const hidden = w.by.length - shown.length;
  const by = shown.map((s) => `${s.tag}*${s.count}`).join(',') || 'none';
  return ` loaded=+${w.loaded} by=${by}${hidden > 0 ? `,+${hidden}more` : ''}`;
}
