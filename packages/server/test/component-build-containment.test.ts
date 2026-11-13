/**
 * What a component build may not reach, and what it may not reveal:
 *
 *  - no git runs for a doc whose `.git` points into a walled lead's
 *    repository, and git that does run ignores an inherited `GIT_*`;
 *  - a path the bound-file guards refuse reads exactly as a missing one, and
 *    is never watched;
 *  - a link is judged by the file it lands on;
 *  - an esm.sh fetch is bounded in time and size, a build in modules and
 *    bytes, and the store in queries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentInputs } from '@claude-workspaces/core/mdx-components';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import {
  type BuildGuards,
  type BuildOutcome,
  MAX_CDN_MODULES_PER_BUILD,
  buildComponent,
  gitWorkTree,
} from '../src/component-build.ts';
import { CdnStore, MAX_CDN_MODULE_BYTES } from '../src/component-cdn.ts';
import { boundFiles } from '../src/slow-fs.ts';

const OPEN: BuildGuards = { allows: () => true, covers: () => false };

let root = '';

function gitIn(cwd: string, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function put(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A repository with a declared folder holding one component. */
function componentRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q');
  put(join(dir, 'components', 'component.json'), '{}');
  put(
    join(dir, 'components', 'ok.tsx'),
    'export default (el: HTMLElement) => { el.textContent = "ok"; };',
  );
  return dir;
}

function buildIn(
  dir: string,
  mdx: string,
  opts: { guards?: BuildGuards; cdn?: CdnStore } = {},
): Promise<BuildOutcome> {
  const input = componentInputs(mdx.split(/\n{2,}/).map((b) => b.trim()))[0];
  if (!input) throw new Error('no component tag');
  return buildComponent({
    docPath: join(dir, 'post.mdx'),
    input,
    cdn:
      opts.cdn ??
      new CdnStore(join(root, 'cdn-unused'), async () => new Response('', { status: 404 })),
    guards: opts.guards ?? OPEN,
  });
}

const errorOf = (out: BuildOutcome) => (out.ok ? '' : out.error);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-containment-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git for a component build', () => {
  it('runs nowhere for a doc whose .git points into a walled lead’s repository', async () => {
    const lead = componentRepo(join(root, 'harborlight-lead'));
    const doc = join(root, 'riverbend-doc');
    mkdirSync(doc);
    put(join(doc, 'components', 'component.json'), '{}');
    put(join(doc, 'components', 'ok.tsx'), 'export default () => {};');
    writeFileSync(join(doc, '.git'), `gitdir: ${join(lead, '.git')}\n`);
    const mdx = "import Ok from './components/ok.tsx'\n\n<Ok />";

    // The control: before the lead's root is registered, git follows the
    // pointer and the doc has a work tree.
    expect(await gitWorkTree(doc)).toBe(doc);

    const roots = new BoardSocketRoots(boardSocketRootsPath(join(root, 'data')));
    roots.set('w-harbor', [lead]);
    const remove = boundFiles.guards.add(roots);
    try {
      expect(boundFiles.guards.covers(join(doc, 'post.mdx'))).toBe(false);
      expect(await gitWorkTree(doc)).toBeNull();
      const out = await buildIn(doc, mdx, { guards: boundFiles.guards });
      expect(errorOf(out)).toContain('only for a doc inside a git work tree');
    } finally {
      remove();
    }
  });

  it('ignores a GIT_DIR the server inherited', async () => {
    const mine = componentRepo(join(root, 'saltmarsh'));
    const other = componentRepo(join(root, 'alice-elsewhere'));
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      // The control: plain git handed that environment answers the other
      // repo. (Bun's child_process takes the launch environment unless told,
      // so the control passes it outright, as a server launched with it would.)
      const plain = spawnSync('git', ['-C', mine, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        env: { ...process.env },
      });
      expect(plain.stdout.trim()).toBe(other);
      expect(await gitWorkTree(mine)).toBe(mine);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
  });
});

describe('a path the guards refuse', () => {
  it('reads as missing, in the same words, and is never watched', async () => {
    const repo = componentRepo(join(root, 'harborlight-walled'));
    put(join(repo, 'walled', 'there.tsx'), 'export default () => {};');
    const walled = join(repo, 'walled');
    const guards: BuildGuards = {
      allows: () => true,
      covers: (p) => p === walled || p.startsWith(`${walled}/`),
    };
    const there = await buildIn(repo, "import T from './walled/there.tsx'\n\n<T />", { guards });
    const absent = await buildIn(repo, "import T from './walled/absent.tsx'\n\n<T />", { guards });
    const words = (out: BuildOutcome) => errorOf(out).replace(/'[^']*'/, "'…'");
    expect(words(there)).toContain('is missing, or is not a file this doc may import');
    expect(words(there)).toBe(words(absent));
    expect(there.watch.some((p) => p.startsWith(walled))).toBe(false);
  });
});

describe('a link is judged by where it lands', () => {
  it('refuses a .tsx name that links to a JSON file', async () => {
    const repo = componentRepo(join(root, 'riverbend-link'));
    put(join(repo, 'components', 'data.json'), '{"rows":[1,2]}');
    symlinkSync(join(repo, 'components', 'data.json'), join(repo, 'components', 'chart.tsx'));
    const out = await buildIn(repo, "import C from './components/chart.tsx'\n\n<C />");
    expect(errorOf(out)).toContain('is a .json file');
  });
});

describe('esm.sh reads are bounded', () => {
  it('gives up on a fetch that never answers', async () => {
    const cdn = new CdnStore(join(root, 'cdn-stall'), () => new Promise<Response>(() => {}), 50);
    await expect(cdn.load('https://esm.sh/harborlight-pad@1.0.0')).rejects.toThrow(
      'did not answer within 50 ms',
    );
  });

  it('gives up on a body that never ends, and stops reading past the cap', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            c.enqueue(chunk);
          },
        }),
      );
    const cdn = new CdnStore(join(root, 'cdn-endless'), async () => endless(), 10_000);
    await expect(cdn.load('https://esm.sh/harborlight-pad@1.0.0')).rejects.toThrow('byte limit');
    expect(pulls).toBeLessThan(MAX_CDN_MODULE_BYTES / chunk.byteLength + 4);
  });

  it('refuses a query in an author’s import, and stores a module once whatever its query', async () => {
    const asked: string[] = [];
    const cdn = new CdnStore(join(root, 'cdn-query'), async (url) => {
      asked.push(url);
      return new Response('export default 1;');
    });
    const repo = componentRepo(join(root, 'saltmarsh-query'));
    const out = await buildIn(
      repo,
      "import P from 'https://esm.sh/harborlight-pad@1.0.0?bundle'\n\n<P />",
      {
        cdn,
      },
    );
    expect(errorOf(out)).toContain('carries a query or fragment');
    await cdn.load('https://esm.sh/harborlight-dep@2.0.0/es2022/dep.mjs?target=es2022&a=1');
    await cdn.load('https://esm.sh/harborlight-dep@2.0.0/es2022/dep.mjs?b=2');
    expect(asked).toEqual(['https://esm.sh/harborlight-dep@2.0.0/es2022/dep.mjs']);
  });

  it('caps the modules one build reads', async () => {
    const many = Array.from(
      { length: MAX_CDN_MODULES_PER_BUILD + 5 },
      (_, i) => `import "/harborlight-dep@2.0.0/es2022/m${i}.mjs";`,
    ).join('\n');
    const cdn = new CdnStore(
      join(root, 'cdn-many'),
      async (url) => new Response(url.includes('/m') ? 'export {};' : many),
    );
    const repo = componentRepo(join(root, 'bob-many'));
    const out = await buildIn(
      repo,
      "import P from 'https://esm.sh/harborlight-pad@1.0.0'\n\n<P />",
      { cdn },
    );
    expect(errorOf(out)).toContain(`more than ${MAX_CDN_MODULES_PER_BUILD} esm.sh modules`);
  });

  it('caps the bytes one build reads', async () => {
    const big = `export const s = "${'x'.repeat(7 * 1024 * 1024)}";`;
    const top = [0, 1, 2, 3]
      .map((i) => `import "/harborlight-dep@2.0.0/es2022/big${i}.mjs";`)
      .join('\n');
    const cdn = new CdnStore(
      join(root, 'cdn-big'),
      async (url) => new Response(url.includes('/big') ? big : top),
    );
    const repo = componentRepo(join(root, 'alice-big'));
    const out = await buildIn(
      repo,
      "import P from 'https://esm.sh/harborlight-pad@1.0.0'\n\n<P />",
      { cdn },
    );
    expect(errorOf(out)).toContain('esm.sh modules pass');
  });
});
