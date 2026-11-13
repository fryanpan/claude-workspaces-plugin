/**
 * Builds the component tags of each open `.mdx` doc and files every build in
 * the doc's `componentBuilds` map (`core/mdx-components.ts`), so every open
 * page draws it and redraws it when it changes.
 *
 * Like `doc-image-versions.ts`, only docs with a page open are swept, one
 * sweep per `.md` poll tick. A sweep reads the doc's `mdx-flow` blocks, so a
 * tag added, edited or deleted is built or dropped within a tick, and stats
 * every file the tag's last build read plus every place a `component.json`
 * could appear, so a saved component file — or a newly declared folder —
 * rebuilds within a tick too, with no commit. The page sees the new hash in
 * the synced map and remounts that one tag.
 *
 * A failed rebuild keeps the last good hash beside its error, so a page keeps
 * the component that worked and shows why the edit did not build. Bundles are
 * written to the data dir under their content hash and served by
 * `routes/doc-components.ts`, which serves a hash only while this doc's map
 * names it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import {
  type ComponentBuild,
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
  mdxFlowSources,
} from '@claude-workspaces/core/mdx-components';
import { isMdxPath } from '@claude-workspaces/core/prose';
import {
  type BuildGuards,
  type BuildOutcome,
  buildComponent,
  gitWorkTree,
} from './component-build.ts';
import { type CdnFetch, CdnStore } from './component-cdn.ts';
import { DOC_STORE_TIMINGS } from './doc-store-timings.ts';
import type { LiveDoc } from './doc-store.ts';
import { boundFiles } from './slow-fs.ts';

/** The transaction origin of every write here. Not an authoring origin. */
export const COMPONENT_BUILD_ORIGIN = 'component-builds';

/** One sweep per `.md` poll tick. */
export const COMPONENT_SWEEP_MS = DOC_STORE_TIMINGS.filePollMs;

/** A doc with more component tags than this builds only its first ones. */
export const MAX_COMPONENTS_PER_DOC = 32;

export interface ComponentBuildHost {
  /** Resident docs with at least one page connected. */
  openDocs(): Iterable<LiveDoc>;
  boundPathOf(docId: string): string | undefined;
}

export interface ComponentBuildOptions {
  dataDir: string;
  /** How esm.sh is reached; a test hands in its own. */
  fetch?: CdnFetch;
  guards?: BuildGuards;
  /** Called with each finished build, for a test to time. */
  onBuilt?: (docId: string, key: string, outcome: BuildOutcome) => void;
}

interface TagState {
  /** Each watched path's mtime (-1 for missing) when the last build began. */
  seen: Map<string, number>;
}

export class DocComponentBuilds {
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly tags = new Map<string, Map<string, TagState>>();
  private readonly workTrees = new Map<string, Promise<string | null>>();
  private readonly cdn: CdnStore;
  readonly bundleDir: string;
  private readonly guards: BuildGuards;

  constructor(
    private readonly host: ComponentBuildHost,
    private readonly opts: ComponentBuildOptions,
  ) {
    this.bundleDir = join(opts.dataDir, 'component-builds');
    this.cdn = new CdnStore(join(opts.dataDir, 'component-cdn'), opts.fetch);
    this.guards = opts.guards ?? boundFiles.guards;
  }

  /** A page connected to `doc`: build its components now, and keep sweeping. */
  noteOpened(doc: LiveDoc): void {
    void this.refresh(doc);
    this.start();
  }

  start(): void {
    if (this.ticker) return;
    const timer = setInterval(() => this.sweep(), COMPONENT_SWEEP_MS);
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

  sweep(): void {
    let open = 0;
    for (const doc of this.host.openDocs()) {
      open++;
      void this.refresh(doc);
    }
    if (open === 0) this.stop();
  }

  /** The bundle file for `hash`, while `docId`'s map names it; else null. */
  bundlePathFor(doc: LiveDoc, hash: string): string | null {
    if (!/^[a-f0-9]{32}$/.test(hash)) return null;
    const map = componentBuildsMap(doc.ydoc);
    for (const key of map.keys()) {
      if (componentBuildOf(map, key)?.hash === hash) return join(this.bundleDir, `${hash}.js`);
    }
    return null;
  }

  /** Build what changed in `doc`, and drop builds whose tag is gone. */
  async refresh(doc: LiveDoc): Promise<void> {
    if (this.inFlight.has(doc.docId)) return;
    const md = this.host.boundPathOf(doc.docId);
    if (!md || !isMdxPath(md)) return;
    this.inFlight.add(doc.docId);
    try {
      const inputs = componentInputs(mdxFlowSources(prose.getProseFragment(doc.ydoc))).slice(
        0,
        MAX_COMPONENTS_PER_DOC,
      );
      const state = this.tags.get(doc.docId) ?? new Map<string, TagState>();
      this.tags.set(doc.docId, state);
      const map = componentBuildsMap(doc.ydoc);
      const live = new Set(inputs.map((i) => i.key));
      const gone = [...map.keys()].filter((k) => !live.has(k));
      for (const k of [...state.keys()]) if (!live.has(k)) state.delete(k);
      if (gone.length > 0) {
        doc.ydoc.transact(() => {
          for (const k of gone) map.delete(k);
        }, COMPONENT_BUILD_ORIGIN);
      }
      for (const input of inputs) {
        const prev = state.get(input.key);
        const recorded = componentBuildOf(map, input.key);
        if (prev && recorded && !(await this.changed(prev.seen))) continue;
        const seen = prev ? await this.stamp([...prev.seen.keys()]) : new Map<string, number>();
        const outcome = await buildComponent({
          docPath: md,
          input,
          cdn: this.cdn,
          guards: this.guards,
          // No git is started in a walled lead's folder; the build refuses it.
          workTree: this.walled(md) ? null : await this.workTreeOf(md),
        });
        // Stamped before the build where the paths were known, so a save
        // landing mid-build still differs on the next sweep.
        const fresh = await this.stamp(outcome.watch.filter((p) => !seen.has(p)));
        for (const [p, v] of fresh) seen.set(p, v);
        for (const p of [...seen.keys()]) if (!outcome.watch.includes(p)) seen.delete(p);
        state.set(input.key, { seen });
        this.record(doc, input.key, outcome);
        this.opts.onBuilt?.(doc.docId, input.key, outcome);
      }
    } finally {
      this.inFlight.delete(doc.docId);
    }
  }

  private walled(path: string): boolean {
    return !this.guards.allows(path) || this.guards.covers(path);
  }

  private workTreeOf(md: string): Promise<string | null> {
    const dir = join(md, '..');
    let p = this.workTrees.get(dir);
    if (!p) {
      p = gitWorkTree(dir);
      this.workTrees.set(dir, p);
    }
    return p;
  }

  private async stamp(paths: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    await Promise.all(
      paths.map(async (p) => {
        const res = await boundFiles.statMtime(p);
        out.set(p, res.status === 'ok' && res.exists ? res.mtimeMs : -1);
      }),
    );
    return out;
  }

  private async changed(seen: Map<string, number>): Promise<boolean> {
    const now = await this.stamp([...seen.keys()]);
    for (const [p, v] of now) if (seen.get(p) !== v) return true;
    return false;
  }

  private record(doc: LiveDoc, key: string, outcome: BuildOutcome): void {
    const map = componentBuildsMap(doc.ydoc);
    const before = componentBuildOf(map, key);
    let next: ComponentBuild;
    if (outcome.ok) {
      mkdirSync(this.bundleDir, { recursive: true, mode: 0o700 });
      const file = join(this.bundleDir, `${outcome.hash}.js`);
      writeFileSync(`${file}.tmp`, outcome.code);
      renameSync(`${file}.tmp`, file);
      if (before?.hash === outcome.hash && before.error === undefined) return;
      next = { hash: outcome.hash, at: Date.now() };
    } else {
      if (before?.error === outcome.error) return;
      next = { error: outcome.error, at: Date.now() };
      if (before?.hash) next.hash = before.hash;
    }
    doc.ydoc.transact(() => map.set(key, next), COMPONENT_BUILD_ORIGIN);
  }
}
