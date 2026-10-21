/**
 * Records the mtime of each image an open bound doc names by a relative path,
 * so the page asks for a new address when the file changes.
 *
 * The assets route (`routes/doc-assets.ts`) serves one address per path. An
 * agent that overwrote `chart.png` left that address unchanged, so a cache
 * keyed on it could keep answering with the old bytes, and a page already
 * showing the image never asked again. Each image's mtime goes into the doc's
 * `imageVersions` map (`@claude-workspaces/core/image-versions`); the page
 * adds it as `?v=<mtime>`, and because the map syncs with the doc, a page
 * that is open re-requests the image within one sweep of the write.
 *
 * Only docs with a page open are swept: nobody else is looking, and the first
 * sweep after a page connects brings the map up to date. A stat goes through
 * `boundFiles`, the same deadline and quarantine the `.md` poll uses, so an
 * image on a provider that has stopped answering parks one pool thread and
 * not the loop. A version is recorded only for a path the route would serve:
 * an image extension, and a real path inside the doc's folder.
 */
import { dirname, extname, join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { imageVersionsMap, relativeImageKeys } from '@claude-workspaces/core/image-versions';
import { IMAGE_TYPES, resolveInside } from './doc-image-store.ts';
import { DOC_STORE_TIMINGS } from './doc-store-timings.ts';
import type { LiveDoc } from './doc-store.ts';
import { boundFiles } from './slow-fs.ts';

/** The transaction origin of every write here. Not an authoring origin. */
export const IMAGE_VERSION_ORIGIN = 'image-versions';

/** One sweep per `.md` poll tick, so a new image shows as fast as a new line. */
export const IMAGE_VERSION_SWEEP_MS = DOC_STORE_TIMINGS.filePollMs;

/** A doc naming more images than this has only its first ones versioned. */
export const MAX_VERSIONED_IMAGES = 64;

export interface ImageVersionHost {
  /** Resident docs with at least one page connected. */
  openDocs(): Iterable<LiveDoc>;
  boundPathOf(docId: string): string | undefined;
}

export class DocImageVersions {
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(private readonly host: ImageVersionHost) {}

  /** A page connected to `doc`: version its images now, and keep sweeping. */
  noteOpened(doc: LiveDoc): void {
    void this.refresh(doc);
    this.start();
  }

  start(): void {
    if (this.ticker) return;
    const timer = setInterval(() => this.sweep(), IMAGE_VERSION_SWEEP_MS);
    timer.unref?.();
    this.ticker = timer;
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  get running(): boolean {
    return this.ticker !== null;
  }

  /** One pass over the open docs. With none open the ticker stops until the next page. */
  sweep(): void {
    let open = 0;
    for (const doc of this.host.openDocs()) {
      open++;
      void this.refresh(doc);
    }
    if (open === 0) this.stop();
  }

  /** Stat every relative image `doc` names and record what changed. */
  async refresh(doc: LiveDoc): Promise<void> {
    if (this.inFlight.has(doc.docId)) return;
    const md = this.host.boundPathOf(doc.docId);
    if (!md) return;
    this.inFlight.add(doc.docId);
    try {
      const dir = dirname(md);
      const keys = relativeImageKeys(prose.getProseFragment(doc.ydoc))
        .filter((k) => IMAGE_TYPES[extname(k).toLowerCase()] !== undefined)
        .slice(0, MAX_VERSIONED_IMAGES);
      const seen = new Map<string, number>();
      const gone = new Set<string>();
      await Promise.all(
        keys.map(async (key) => {
          const res = await boundFiles.statMtime(join(dir, ...key.split('/')));
          if (res.status !== 'ok') return; // unknown: keep what is recorded
          if (res.exists) seen.set(key, res.mtimeMs);
          else gone.add(key);
        }),
      );
      const map = imageVersionsMap(doc.ydoc);
      const named = new Set(keys);
      const sets: Array<[string, number]> = [];
      for (const [key, v] of seen) {
        if (map.get(key) === v) continue;
        // Asked of where the path LANDS, as the route asks it, and only when
        // the version moved, so the synchronous realpath runs once per change.
        if (resolveInside(dir, key.split('/'))) sets.push([key, v]);
        else gone.add(key);
      }
      const drops = [...map.keys()].filter((k) => !named.has(k) || gone.has(k));
      if (sets.length === 0 && drops.length === 0) return;
      doc.ydoc.transact(() => {
        for (const [key, v] of sets) map.set(key, v);
        for (const key of drops) map.delete(key);
      }, IMAGE_VERSION_ORIGIN);
    } finally {
      this.inFlight.delete(doc.docId);
    }
  }
}
