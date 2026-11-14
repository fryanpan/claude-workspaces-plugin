/**
 * A component tag builds for a doc inside a walled lead's registered folder,
 * and the build reads nothing there except through `tree-fs.ts`:
 *
 *  - the lead root that holds the doc is the boundary, and no git runs;
 *  - esbuild never opens a path under the root itself: every file it bundles
 *    from there is resolved by the policy plugin and handed over as contents;
 *  - a link (file or folder), a hard link, an import that climbs out of the
 *    root or into another root, and a file swapped for a link between resolve
 *    and load each read as missing, and nothing they point at reaches output;
 *  - a saved component file under the root rebuilds through the same stamps.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import {
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
} from '@claude-workspaces/core/mdx-components';
import * as Y from 'yjs';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { type BuildGuards, type BuildOutcome, buildComponent } from '../src/component-build.ts';
import { CdnStore } from '../src/component-cdn.ts';
import { DocComponentBuilds } from '../src/doc-component-builds.ts';
import type { LiveDoc } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { setTreeSeamForTest } from '../src/tree-fs.ts';

const MARKER = 'RIVERBEND_OUTSIDE_MARKER_7c1f';
const CAROUSEL =
  'export default function mount(el: HTMLElement) { el.textContent = "Harborlight carousel"; }\n';
const REFUSED = 'is missing, or is not a file this doc may import';

let tmp = '';
const noCdn = () =>
  new CdnStore(join(tmp, 'cdn-unused'), async () => new Response('', { status: 404 }));

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function inputOf(mdx: string) {
  const input = componentInputs(mdx.split(/\n{2,}/).map((b) => b.trim()))[0];
  if (!input) throw new Error('no component tag');
  return input;
}

function buildAt(docPath: string, mdx: string, guards: BuildGuards): Promise<BuildOutcome> {
  return buildComponent({ docPath, input: inputOf(mdx), cdn: noCdn(), guards });
}

/** Everything a build hands back, for a marker search. */
const everything = (out: BuildOutcome) => (out.ok ? out.code : out.error);
const errorOf = (out: BuildOutcome) => (out.ok ? '' : out.error);

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'component-lead-root-')));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('esbuild reads nothing under a lead root by path', () => {
  // Runs on every platform: the files exist only in this map, at a root that
  // is not on disk, so any read esbuild made by path would fail the build.
  const ROOT = '/nonexistent-harborlight-root-4b2e';
  const files = new Map<string, string>([
    [`${ROOT}/notes/components/component.json`, '{}'],
    [
      `${ROOT}/notes/components/carousel.tsx`,
      "import { word } from './word';\n" + CAROUSEL.replace('"Harborlight carousel"', 'word'),
    ],
    [`${ROOT}/notes/components/word.ts`, 'export const word = "Saltmarsh slide";\n'],
  ]);
  const under = (p: string) => p === ROOT || p.startsWith(`${ROOT}/`);
  const memory: BuildGuards = {
    allows: () => true,
    covers: under,
    containedOf: (p) => (under(p) ? { root: ROOT, abs: p } : null),
    stat: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: BigInt(files.get(p)?.length ?? 0) } as BigIntStats;
    },
    readBytes: async (p) => {
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { bytes: new TextEncoder().encode(text), st: {} as BigIntStats };
    },
  };

  it('builds from contents the plugin hands over', async () => {
    const out = await buildAt(
      `${ROOT}/notes/post.mdx`,
      "import Carousel from './components/carousel.tsx'\n\n<Carousel />",
      memory,
    );
    expect(errorOf(out)).toBe('');
    expect(everything(out)).toContain('Saltmarsh slide');
    expect(out.watch).toContain(`${ROOT}/notes/components/carousel.tsx`);
    expect(out.watch).toContain(`${ROOT}/notes/components/component.json`);
  });
});

describe.skipIf(process.platform !== 'darwin')('a doc in a walled lead’s folder', () => {
  let lead = '';
  let other = '';
  let outside = '';
  let notes = '';
  let doc = '';
  let remove: () => void = () => {};
  const guards = () => boundFiles.guards;

  beforeAll(() => {
    lead = join(tmp, 'harborlight-lead');
    other = join(tmp, 'riverbend-lead');
    outside = join(tmp, 'outside');
    // The shape the bug report names, files unchanged.
    notes = join(lead, 'research', 'notes', 'whitepaper-2026-11');
    doc = join(notes, 'post.mdx');
    put(join(notes, 'components', 'component.json'), '{}');
    put(join(notes, 'components', 'carousel.tsx'), CAROUSEL);
    put(doc, "import Carousel from './components/carousel.tsx'\n\n<Carousel />\n");
    spawnSync('git', ['init', '-q'], { cwd: lead });
    // Outside every root, a declared folder holding the marker.
    put(join(outside, 'component.json'), '{}');
    put(join(outside, 'secret.tsx'), `export default () => "${MARKER}";\n`);
    // Another board's root, also declared.
    put(join(other, 'components', 'component.json'), '{}');
    put(join(other, 'components', 'secret.tsx'), `export default () => "${MARKER}";\n`);

    const roots = new BoardSocketRoots(boardSocketRootsPath(join(tmp, 'data')));
    roots.set('w-harbor', [lead]);
    roots.set('w-river', [other]);
    remove = boundFiles.guards.add(roots);
  });

  afterAll(() => remove());
  afterEach(() => setTreeSeamForTest(null));

  it('builds its component, with no git and no work tree', async () => {
    expect(guards().covers(doc)).toBe(true);
    const out = await buildAt(
      doc,
      "import Carousel from './components/carousel.tsx'\n\n<Carousel />",
      guards(),
    );
    expect(errorOf(out)).toBe('');
    expect(everything(out)).toContain('Harborlight carousel');
  });

  it('refuses a link to a file outside the root, and leaks nothing', async () => {
    symlinkSync(join(outside, 'secret.tsx'), join(notes, 'components', 'far.tsx'));
    // The positive control: the link does reach the marker by path.
    expect(readFileSync(join(notes, 'components', 'far.tsx'), 'utf8')).toContain(MARKER);
    const out = await buildAt(doc, "import Far from './components/far.tsx'\n\n<Far />", guards());
    expect(errorOf(out)).toContain(REFUSED);
    expect(everything(out)).not.toContain(MARKER);
  });

  it('refuses a linked folder', async () => {
    symlinkSync(outside, join(notes, 'linked'));
    expect(readFileSync(join(notes, 'linked', 'secret.tsx'), 'utf8')).toContain(MARKER);
    const out = await buildAt(doc, "import S from './linked/secret.tsx'\n\n<S />", guards());
    expect(errorOf(out)).toContain(REFUSED);
    expect(everything(out)).not.toContain(MARKER);
  });

  it('refuses a hard link to a file outside', async () => {
    linkSync(join(outside, 'secret.tsx'), join(notes, 'components', 'hard.tsx'));
    expect(readFileSync(join(notes, 'components', 'hard.tsx'), 'utf8')).toContain(MARKER);
    const out = await buildAt(doc, "import H from './components/hard.tsx'\n\n<H />", guards());
    expect(errorOf(out)).toContain(REFUSED);
    expect(everything(out)).not.toContain(MARKER);
  });

  it('refuses an import that climbs out of the root, in the same words as a missing file', async () => {
    const climb = '../../../../outside/secret.tsx';
    // The positive control: the climb names the marker file.
    expect(readFileSync(join(notes, climb), 'utf8')).toContain(MARKER);
    const out = await buildAt(doc, `import S from '${climb}'\n\n<S />`, guards());
    const missing = await buildAt(
      doc,
      "import S from './components/absent.tsx'\n\n<S />",
      guards(),
    );
    const words = (o: BuildOutcome) => errorOf(o).replace(/'[^']*'/, "'…'");
    expect(errorOf(out)).toContain(REFUSED);
    expect(words(out)).toBe(words(missing));
    expect(everything(out)).not.toContain(MARKER);
  });

  it('refuses an import into another lead’s root', async () => {
    const across = '../../../../riverbend-lead/components/secret.tsx';
    expect(readFileSync(join(notes, across), 'utf8')).toContain(MARKER);
    const out = await buildAt(doc, `import S from '${across}'\n\n<S />`, guards());
    expect(errorOf(out)).toContain(REFUSED);
    expect(everything(out)).not.toContain(MARKER);
  });

  it('refuses a file swapped for a link between resolve and load', async () => {
    const target = join(notes, 'components', 'swapped.tsx');
    put(target, CAROUSEL);
    let swapped = false;
    setTreeSeamForTest((c) => {
      if (c.abs !== target || swapped) return;
      swapped = true;
      renameSync(target, `${target}.orig`);
      symlinkSync(join(outside, 'secret.tsx'), target);
    });
    const out = await buildAt(doc, "import W from './components/swapped.tsx'\n\n<W />", guards());
    expect(swapped).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain(MARKER);
    expect(errorOf(out)).toContain(REFUSED);
    expect(everything(out)).not.toContain(MARKER);
  });

  it('rebuilds when a component file under the root is saved', async () => {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(ydoc),
      "# Saltmarsh\n\nimport Carousel from './components/carousel.tsx'\n\n<Carousel />\n",
      { mdx: true },
    );
    const live = { docId: 'harbor-post', ydoc } as unknown as LiveDoc;
    const builds = new DocComponentBuilds(
      { openDocs: () => [live], boundPathOf: () => doc },
      { dataDir: join(tmp, 'data'), guards: guards() },
    );
    const key =
      componentInputs(["import Carousel from './components/carousel.tsx'", '<Carousel />'])[0]
        ?.key ?? '';
    await builds.refresh(live);
    const first = componentBuildOf(componentBuildsMap(ydoc), key);
    expect(first?.error).toBeUndefined();
    expect(first?.hash).toMatch(/^[a-f0-9]{32}$/);

    const file = join(notes, 'components', 'carousel.tsx');
    writeFileSync(file, CAROUSEL.replace('Harborlight carousel', 'Bob carousel'));
    const later = new Date(Date.now() + 120_000);
    utimesSync(file, later, later);
    await builds.refresh(live);
    const second = componentBuildOf(componentBuildsMap(ydoc), key);
    expect(second?.error).toBeUndefined();
    expect(second?.hash).not.toBe(first?.hash);
  });
});
