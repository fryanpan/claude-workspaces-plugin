/**
 * A component tag in a bound `.mdx` builds into a module that draws in a page,
 * and the build reads only what the design allows: a declared folder's files
 * inside the doc's git work tree, and esm.sh modules at an exact version.
 * Everything else is refused with the fix, and a macro import runs nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentInputs } from '@claude-workspaces/core/mdx-components';
import { Window } from 'happy-dom';
import { type BuildOutcome, buildComponent } from '../src/component-build.ts';
import { CdnStore } from '../src/component-cdn.ts';

const OPEN = { allows: () => true, covers: () => false };

/** A fake esm.sh: a top-level module that imports a nested one by path. */
const CDN: Record<string, string> = {
  'https://esm.sh/harborlight-pad@1.0.0?target=es2022':
    'import "/harborlight-dep@2.0.0/es2022/dep.mjs";\nexport default (s) => `[${s}]`;',
  'https://esm.sh/harborlight-dep@2.0.0/es2022/dep.mjs': 'globalThis.__depRan = true;',
};

let root: string;
let repo: string;
let fetched: string[];
let cdn: CdnStore;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function put(rel: string, text: string) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

/** Build the first component tag of an `.mdx` body. */
async function build(mdx: string): Promise<BuildOutcome> {
  const blocks = mdx.split(/\n{2,}/).map((b) => b.trim());
  const input = componentInputs(blocks)[0];
  if (!input) throw new Error('no component tag');
  return buildComponent({ docPath: join(repo, 'post.mdx'), input, cdn, guards: OPEN });
}

/** Draw a built bundle in a fresh DOM and return the host's text. */
async function draw(out: BuildOutcome, builtins = {}): Promise<HTMLElement> {
  if (!out.ok) throw new Error(out.error);
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.Node = win.Node;
  const file = join(root, `${out.hash}.mjs`);
  writeFileSync(file, out.code);
  const mod = (await import(file)) as { default: (h: HTMLElement, api: unknown) => () => void };
  const host = win.document.createElement('div') as unknown as HTMLElement;
  mod.default(host, { builtins });
  return host;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-build-')));
  repo = join(root, 'harborlight');
  mkdirSync(repo);
  git('init', '-q');
  put('components/component.json', '{}');
  put(
    'components/greet.tsx',
    [
      "import pad from 'https://esm.sh/harborlight-pad@1.0.0';",
      "import { shout } from './shout.ts';",
      'export default function mount(el: HTMLElement, props: { name: string }) {',
      '  el.append(<b class="who">{pad(shout(props.name))}</b>);',
      '}',
    ].join('\n'),
  );
  put('components/shout.ts', 'export const shout = (s: string) => s.toUpperCase();');
  put('loose/widget.tsx', 'export default (el: HTMLElement) => { el.textContent = "x"; };');
  put('.gitignore', 'components/secret.tsx\n');
  put('components/secret.tsx', 'export default (el: HTMLElement) => { el.textContent = "s"; };');
  fetched = [];
  cdn = new CdnStore(join(root, 'cdn'), async (url) => {
    fetched.push(url);
    const body = CDN[url];
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a component tag builds and draws', () => {
  it('imports a declared folder’s .tsx and an exact-version esm.sh module', async () => {
    const out = await build(
      'import Greet from \'./components/greet.tsx\'\n\n<Greet name="Riverbend" />',
    );
    const host = await draw(out);
    expect(host.querySelector('.mdx-component .who')?.textContent).toBe('[RIVERBEND]');
    expect((globalThis as Record<string, unknown>).__depRan).toBe(true);
    expect(fetched).toEqual([
      'https://esm.sh/harborlight-pad@1.0.0?target=es2022',
      'https://esm.sh/harborlight-dep@2.0.0/es2022/dep.mjs',
    ]);
  });

  it('builds again from the stored copy without fetching', async () => {
    const before = fetched.length;
    const out = await build('import Greet from \'./components/greet.tsx\'\n\n<Greet name="Bob" />');
    expect(out.ok).toBe(true);
    expect(fetched.length).toBe(before);
  });

  it('watches every file it read and every place a component.json could be', async () => {
    const out = await build('import Greet from \'./components/greet.tsx\'\n\n<Greet name="Bob" />');
    expect(out.watch).toContain(join(repo, 'components', 'greet.tsx'));
    expect(out.watch).toContain(join(repo, 'components', 'component.json'));
  });

  it('hands a component its children drawn, a built-in <PlotChart> among them', async () => {
    put(
      'components/slides.tsx',
      [
        'export default function mount(el: HTMLElement, props: { children: Node[] }) {',
        '  for (const c of props.children) {',
        "    const slide = document.createElement('section');",
        '    slide.append(c);',
        '    el.append(slide);',
        '  }',
        '}',
      ].join('\n'),
    );
    const out = await build(
      [
        "import Slides from './components/slides.tsx'",
        '<Slides>\n  <PlotChart subtitle="Harborlight" marks={[]} />\n  <PlotChart subtitle="Saltmarsh" marks={[]} />\n</Slides>',
      ].join('\n\n'),
    );
    const drawn: string[] = [];
    const host = await draw(out, {
      PlotChart: (el: HTMLElement, props: { subtitle: string }) => {
        drawn.push(props.subtitle);
        el.textContent = props.subtitle;
      },
    });
    expect(drawn).toEqual(['Harborlight', 'Saltmarsh']);
    expect([...host.querySelectorAll('section')].map((s) => s.textContent)).toEqual([
      'Harborlight',
      'Saltmarsh',
    ]);
  });
});

describe('what a build refuses, each with the fix', () => {
  const refusal = async (mdx: string) => {
    const out = await build(mdx);
    expect(out.ok).toBe(false);
    return out.ok ? '' : out.error;
  };

  it('a file in a folder no component.json declares', async () => {
    const error = await refusal("import W from './loose/widget.tsx'\n\n<W />");
    expect(error).toContain('not in a declared folder');
    expect(error).toContain('add component.json to loose/');
  });

  it('a bare import, naming the esm.sh form', async () => {
    put('components/leafy.tsx', "import L from 'leaflet';\nexport default () => L;");
    const error = await refusal("import Leafy from './components/leafy.tsx'\n\n<Leafy />");
    expect(error).toContain("'leaflet' is a bare import");
    expect(error).toContain("'https://esm.sh/leaflet@<exact version>'");
  });

  it('a bare import written in the doc itself', async () => {
    const error = await refusal("import Map from 'leaflet'\n\n<Map />");
    expect(error).toContain('https://esm.sh/leaflet@<exact version>');
  });

  for (const [spec, why] of [
    ['https://esm.sh/harborlight-pad@^1.0.0', 'range or a tag'],
    ['https://esm.sh/harborlight-pad@1.0', 'range or a tag'],
    ['https://esm.sh/harborlight-pad@latest', 'range or a tag'],
    ['https://esm.sh/harborlight-pad', 'has no version'],
    ['https://cdn.example.com/harborlight-pad@1.0.0', 'not on an allowed host'],
  ] as const) {
    it(`${spec}: ${why}`, async () => {
      const error = await refusal(`import Pad from '${spec}'\n\n<Pad />`);
      expect(error).toContain(why);
      expect(error).toContain('esm.sh/');
    });
  }

  it('a file git ignores', async () => {
    const error = await refusal("import S from './components/secret.tsx'\n\n<S />");
    expect(error).toContain('ignored by git');
  });

  it('a link out of the work tree', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'far.tsx'), 'export default () => {};');
    symlinkSync(join(outside, 'far.tsx'), join(repo, 'components', 'far.tsx'));
    const error = await refusal("import Far from './components/far.tsx'\n\n<Far />");
    expect(error).toContain('is missing, or is not a file this doc may import');
  });

  it('a doc a walled lead holds, where the guards cannot read through tree-fs', async () => {
    const blocks = ["import Greet from './components/greet.tsx'", '<Greet />'];
    const input = componentInputs(blocks)[0];
    if (!input) throw new Error('no tag');
    const out = await buildComponent({
      docPath: join(repo, 'post.mdx'),
      input,
      cdn,
      guards: { allows: () => true, covers: () => true },
    });
    expect(out.ok ? '' : out.error).toContain('walled lead');
  });
});

describe('a macro import runs nothing at build', () => {
  const macro = (marker: string) =>
    [
      "import { writeFileSync } from 'node:fs';",
      `export function mark() { writeFileSync(${JSON.stringify(marker)}, 'macro ran'); return 1; }`,
    ].join('\n');

  it('is refused, and the marker file is never written', async () => {
    const marker = join(root, 'marker-esbuild');
    put('components/m.ts', macro(marker));
    put(
      'components/uses-macro.tsx',
      "import { mark } from './m.ts' with { type: 'macro' };\nexport default (el: HTMLElement) => { el.textContent = String(mark()); };",
    );
    const out = await build("import U from './components/uses-macro.tsx'\n\n<U />");
    expect(out.ok ? '' : out.error).toContain('macros are refused');
    expect(existsSync(marker)).toBe(false);
  });

  it('control: Bun’s bundler, given the same files, does write the marker', async () => {
    const marker = join(root, 'marker-bun');
    put('components/m2.ts', macro(marker));
    put(
      'components/uses-macro2.tsx',
      "import { mark } from './m2.ts' with { type: 'macro' };\nexport default () => mark();",
    );
    await Bun.build({ entrypoints: [join(repo, 'components', 'uses-macro2.tsx')] });
    expect(existsSync(marker)).toBe(true);
  });
});
