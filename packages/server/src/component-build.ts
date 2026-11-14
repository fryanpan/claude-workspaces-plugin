/**
 * Builds one component tag of a bound `.mdx` doc into a browser module, with
 * esbuild pinned in `packages/server/package.json` (design decisions 1, 3, 4
 * and 6).
 *
 * The entry is the tag's own imports plus the tag, compiled with the JSX
 * runtime in `core/mdx-component-runtime.ts`; its default export draws the
 * tag into the element the page hands it. What the build may read is decided
 * here, in one resolver every import passes through:
 *
 *  - a relative import resolves to a real file inside the doc's git work
 *    tree, in a folder that holds `component.json` or under one (not the work
 *    tree's root itself: a `component.json` there would declare the whole
 *    repository), with a component extension, and not ignored by git
 *    unless the owner granted a folder holding it (decision 5,
 *    `component-grants.ts`);
 *  - an `https://` import names esm.sh at an exact version (`component-cdn.ts`),
 *    and what that module imports stays on esm.sh;
 *  - a bare import (`from 'leaflet'`) is refused with the esm.sh form;
 *  - an import `with { type: 'macro' }` is refused. Bun's bundler runs a macro
 *    at build time as the server's user even with macros turned off (measured
 *    on Bun 1.3.10); esbuild runs no code from the files it bundles, and the
 *    refusal says why rather than leaving esbuild's own message.
 *
 * No `tsconfig.json` is read (`tsconfigRaw: {}`), so a `paths` entry in the
 * doc's repository cannot send an import around the resolver, and nothing is
 * inlined from the server's environment (`define` is empty).
 *
 * A doc inside a walled lead's registered folder builds with that lead root
 * as its boundary in place of the work tree, and no git runs there
 * (`gitBarred`). Under a root every file is found and read through the
 * bound-path guards, which send it to `tree-fs.ts` (a judged descriptor, no
 * link anywhere on the path, one name): the resolver answers each import with
 * a path in its own namespace, and the loader hands esbuild the contents, so
 * esbuild never opens a path there itself. A candidate counts only when the
 * guards place it under the same root as the doc. The git-ignore check does
 * not run there: it needs git, and the lead could commit any file it likes,
 * so it would not protect anything from the lead.
 *
 * Elsewhere, a path the guards refuse reads exactly as a missing one, so a
 * refusal says nothing about what exists there. Git runs only where
 * `gitBarred` allows it, and then with the repository's program-running
 * settings off (`git-hardening.ts`): a doc whose `.git` points into a lead's
 * repository has no work tree, so it builds nothing.
 *
 * One build fetches at most `MAX_CDN_MODULES_PER_BUILD` esm.sh modules and
 * `MAX_CDN_BYTES_PER_BUILD` bytes of them.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type BigIntStats, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_TAGS,
  COMPONENT_EXTENSIONS,
  type ComponentInput,
  parseImports,
} from '@claude-workspaces/core/mdx-components';
import * as esbuild from 'esbuild';
import { type CdnStore, cdnImportRefusal, resolveCdnImport } from './component-cdn.ts';
import { gitBarred, hardenedGitArgs, hardenedGitEnv } from './git-hardening.ts';
import type { Contained } from './tree-fs.ts';

/** The most a built bundle may weigh. */
export const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;

/** The most esm.sh modules one build may read. */
export const MAX_CDN_MODULES_PER_BUILD = 400;

/** The most bytes of esm.sh modules one build may read. */
export const MAX_CDN_BYTES_PER_BUILD = 24 * 1024 * 1024;

/** The file a folder holds to declare its files components (decision 4). */
export const COMPONENT_MANIFEST = 'component.json';

/** The runtime's source, resolved on the first build: vitest's module
 *  runner, which loads this file through the scripts suite, has no
 *  `import.meta.resolve`. */
let runtimeSource: string | null = null;
const readRuntime = (): string => {
  runtimeSource ??= readFileSync(
    fileURLToPath(import.meta.resolve('@claude-workspaces/core/mdx-component-runtime')),
    'utf8',
  );
  return runtimeSource;
};
const RUNTIME_SPECIFIERS = new Set(['cw:runtime', 'cw/jsx-runtime', 'cw/jsx-dev-runtime']);

/** The part of `PathGuards` a build uses. Without the last three, a doc in a
 *  walled lead's folder builds nothing. */
export interface BuildGuards {
  allows(path: string): boolean;
  covers(path: string): boolean;
  containedOf?(path: string): Contained | null;
  stat?(path: string): Promise<BigIntStats>;
  readBytes?(
    path: string,
    max: number,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; st: BigIntStats } | 'too-large' | null>;
}

/** The namespace of a module read from a lead root: esbuild opens no path in it. */
const LEAD_NAMESPACE = 'cw-lead';

const LOADERS: Record<string, esbuild.Loader> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
};

export interface BuildRequest {
  /** The bound `.mdx` file. */
  docPath: string;
  input: ComponentInput;
  cdn: CdnStore;
  guards: BuildGuards;
  /** The doc's git work tree, when the caller already knows it. Not used
   *  for a doc under a lead root, where no git runs. */
  workTree?: string | null;
  /** Whether the owner granted a folder holding this real path, asked only
   *  for a file git ignores. Absent: nothing is granted. */
  granted?: (realPath: string) => boolean;
}

export type BuildOutcome =
  | { ok: true; code: string; hash: string; watch: string[] }
  | { ok: false; error: string; watch: string[] };

/** The git work tree `dir` is in, as a real path, or null. Null too where
 *  no git may run (`gitBarred`). */
export function gitWorkTree(dir: string): Promise<string | null> {
  if (gitBarred(dir)) return Promise.resolve(null);
  return new Promise((done) => {
    const child = spawn('git', hardenedGitArgs(['-C', dir, 'rev-parse', '--show-toplevel']), {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: hardenedGitEnv(),
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      const top = out.trim();
      if (code !== 0 || !top) return done(null);
      try {
        done(realpathSync(top));
      } catch {
        done(null);
      }
    });
  });
}

/** Whether git ignores `rel` in `workTree`. A tracked file is never ignored.
 *  Where no git may run, every file counts as ignored. */
function gitIgnores(workTree: string, rel: string): Promise<boolean> {
  if (gitBarred(workTree)) return Promise.resolve(true);
  return new Promise((done) => {
    const child = spawn('git', hardenedGitArgs(['-C', workTree, 'check-ignore', '-q', '--', rel]), {
      stdio: 'ignore',
      env: hardenedGitEnv(),
    });
    child.on('error', () => done(true));
    child.on('close', (code) => done(code !== 1));
  });
}

/** The entry module: the tag's imports, a binding for each built-in it uses
 *  without importing, and the tag drawn by the runtime. */
export function entrySource(input: ComponentInput): string {
  const bound = new Set(input.imports.flatMap((s) => parseImports(s).flatMap((i) => i.names)));
  const builtins = BUILTIN_TAGS.filter(
    (name) => !bound.has(name) && new RegExp(`<${name}[\\s/>]`).test(input.tag),
  ).map((name) => `const ${name} = __cwBuiltin(${JSON.stringify(name)});`);
  return [
    "import { render as __cwRender, builtin as __cwBuiltin } from 'cw:runtime';",
    ...input.imports,
    ...builtins,
    'export default (host, api) => __cwRender(host, api, () => (',
    input.tag,
    '));',
    '',
  ].join('\n');
}

/** A file to try for `abs`: as written, then with each component extension,
 *  then as a folder's index. */
function candidates(abs: string): string[] {
  if (extname(abs)) return [abs];
  return [
    ...COMPONENT_EXTENSIONS.map((e) => abs + e),
    ...COMPONENT_EXTENSIONS.map((e) => join(abs, `index${e}`)),
  ];
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The lead root holding `path`, as the guards spell it; null where the
 *  guards cannot read it through `tree-fs.ts` (off macOS, or a fake). */
function containedIn(guards: BuildGuards, path: string): Contained | null {
  if (!guards.containedOf || !guards.stat || !guards.readBytes) return null;
  if (!guards.allows(path)) return null;
  try {
    return guards.containedOf(path);
  } catch {
    return null;
  }
}

export async function buildComponent(req: BuildRequest): Promise<BuildOutcome> {
  const watch = new Set<string>();
  const done = (error: string): BuildOutcome => ({ ok: false, error, watch: [...watch] });
  const walled = "Components are not built for a doc inside a walled lead's folder.";
  if (!req.guards.allows(req.docPath)) return done(walled);
  let lead: Contained | null = null;
  if (req.guards.covers(req.docPath)) {
    lead = containedIn(req.guards, req.docPath);
    if (!lead) return done(walled);
  }
  const leadRoot = lead?.root ?? null;
  const docDir = dirname(lead ? lead.abs : req.docPath);
  let workTree = '';
  if (!lead) {
    const found = req.workTree === undefined ? await gitWorkTree(docDir) : req.workTree;
    if (!found) return done('Components are built only for a doc inside a git work tree.');
    workTree = found;
  }

  const refused = (spec: string) => ({
    errors: [
      {
        text: `'${spec}' is missing, or is not a file this doc may import: a component lives in the doc's git work tree`,
      },
    ],
  });
  const notComponent = (spec: string, ext: string) => ({
    errors: [
      {
        text: `'${spec}' is a ${ext || 'extension-less'} file; a component is one of ${COMPONENT_EXTENSIONS.join(' ')}`,
      },
    ],
  });
  const undeclared = (spec: string, top: string, file: string) => ({
    errors: [
      {
        text: `'${spec}' is not in a declared folder: add ${COMPONENT_MANIFEST} to ${relative(top, dirname(file)) || '.'}/ (or a folder above it, below the repository root) to let docs import it`,
      },
    ],
  });

  /** `path` as the doc's lead root holds it, or null: under another root,
   *  outside every root, or refused by the guards. */
  const inLead = (path: string): Contained | null => {
    const c = containedIn(req.guards, path);
    return c && c.root === leadRoot ? c : null;
  };
  /** Whether `tree-fs.ts` opens `path` as a regular file with one name. */
  const leadFile = async (path: string): Promise<boolean> => {
    try {
      await req.guards.stat?.(path);
      return true;
    } catch {
      return false;
    }
  };
  const leadLocal = async (spec: string, resolveDir: string): Promise<esbuild.OnResolveResult> => {
    if (!leadRoot) return refused(spec);
    let found: string | null = null;
    for (const cand of candidates(resolve(resolveDir, spec))) {
      const c = inLead(cand);
      if (!c) continue;
      watch.add(c.abs);
      if (await leadFile(c.abs)) {
        found = c.abs;
        break;
      }
    }
    if (!found) return refused(spec);
    const ext = extname(found).toLowerCase();
    if (!(COMPONENT_EXTENSIONS as readonly string[]).includes(ext)) return notComponent(spec, ext);
    let declared = false;
    for (let dir = dirname(found); dir.startsWith(leadRoot + sep); dir = dirname(dir)) {
      const m = join(dir, COMPONENT_MANIFEST);
      watch.add(m);
      if (inLead(m) && (await leadFile(m))) {
        declared = true;
        break;
      }
    }
    if (!declared) return undeclared(spec, leadRoot, found);
    return { path: found, namespace: LEAD_NAMESPACE, pluginData: { spec } };
  };
  const leadLoad = async (path: string, spec: string): Promise<esbuild.OnLoadResult> => {
    const c = inLead(path);
    if (!c) return refused(spec);
    let got: Awaited<ReturnType<NonNullable<BuildGuards['readBytes']>>>;
    try {
      got = (await req.guards.readBytes?.(c.abs, MAX_BUNDLE_BYTES)) ?? null;
    } catch {
      return refused(spec);
    }
    if (got === null) return refused(spec);
    if (got === 'too-large') {
      return { errors: [{ text: `'${spec}' is over ${MAX_BUNDLE_BYTES} bytes` }] };
    }
    return {
      contents: got.bytes,
      loader: LOADERS[extname(c.abs).toLowerCase()] ?? 'js',
      resolveDir: dirname(c.abs),
    };
  };

  const allowed = (p: string) => req.guards.allows(p) && !req.guards.covers(p);
  const local = async (spec: string, resolveDir: string): Promise<esbuild.OnResolveResult> => {
    if (lead) return leadLocal(spec, resolveDir);
    const asked = resolve(resolveDir, spec);
    // The guards answer before anything is stat'ed or watched, and a path
    // they refuse reads as missing: the message is the same either way.
    const found = candidates(asked).find((c) => {
      if (!allowed(c)) return false;
      watch.add(c);
      return isFile(c);
    });
    if (!found) return refused(spec);
    let real: string;
    try {
      real = realpathSync(found);
    } catch {
      return refused(spec);
    }
    if (!allowed(real) || !real.startsWith(workTree + sep)) return refused(spec);
    // Judged on where a link lands: `chart.tsx -> data.json` is a JSON file.
    const ext = extname(real).toLowerCase();
    if (!(COMPONENT_EXTENSIONS as readonly string[]).includes(ext)) return notComponent(spec, ext);
    const manifest = declaringManifest(real, workTree, watch);
    if (!manifest) return undeclared(spec, workTree, real);
    if ((await gitIgnores(workTree, relative(workTree, real))) && !req.granted?.(real)) {
      return {
        errors: [
          {
            text: `'${spec}' is ignored by git, and a source git does not list builds only once the owner grants its folder: ask with request_component_grant, or un-ignore it`,
          },
        ],
      };
    }
    return { path: real };
  };

  let cdnModules = 0;
  let cdnBytes = 0;

  const policy: esbuild.Plugin = {
    name: 'cw-component-policy',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.with?.type === 'macro') {
          return {
            errors: [
              {
                text: `'${args.path}' is imported with { type: 'macro' }, which would run its code on the server while building: macros are refused, remove the with { type: 'macro' }`,
              },
            ],
          };
        }
        if (RUNTIME_SPECIFIERS.has(args.path)) return { path: 'runtime', namespace: 'cw-runtime' };
        if (args.namespace === 'cdn') {
          const url = resolveCdnImport(args.path, args.importer);
          if (url) return { path: url, namespace: 'cdn' };
          return {
            errors: [{ text: `${args.importer} imports '${args.path}', which leaves esm.sh` }],
          };
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(args.path)) {
          const refusal = cdnImportRefusal(args.path);
          if (refusal) return { errors: [{ text: refusal }] };
          return { path: args.path, namespace: 'cdn' };
        }
        if (/^\.{0,2}\//.test(args.path)) return local(args.path, args.resolveDir || docDir);
        if (/^[a-z][a-z0-9+.-]*:/i.test(args.path)) {
          return { errors: [{ text: `'${args.path}' is not something a doc can import` }] };
        }
        return {
          errors: [
            {
              text: `'${args.path}' is a bare import, which is refused: import it from esm.sh at an exact version, as 'https://esm.sh/${args.path}@<exact version>'`,
            },
          ],
        };
      });
      b.onLoad({ filter: /.*/, namespace: LEAD_NAMESPACE }, (args) =>
        leadLoad(args.path, String((args.pluginData as { spec?: string } | undefined)?.spec)),
      );
      b.onLoad({ filter: /.*/, namespace: 'cw-runtime' }, () => ({
        contents: readRuntime(),
        loader: 'ts',
      }));
      b.onLoad({ filter: /.*/, namespace: 'cdn' }, async (args) => {
        if (++cdnModules > MAX_CDN_MODULES_PER_BUILD) {
          return {
            errors: [
              {
                text: `this component imports more than ${MAX_CDN_MODULES_PER_BUILD} esm.sh modules`,
              },
            ],
          };
        }
        try {
          const contents = await req.cdn.load(args.path);
          cdnBytes += contents.length;
          if (cdnBytes > MAX_CDN_BYTES_PER_BUILD) {
            return {
              errors: [
                { text: `this component's esm.sh modules pass ${MAX_CDN_BYTES_PER_BUILD} bytes` },
              ],
            };
          }
          return { contents, loader: 'js' };
        } catch (err) {
          return { errors: [{ text: err instanceof Error ? err.message : String(err) }] };
        }
      });
    },
  };

  let result: esbuild.BuildResult<{ write: false }>;
  try {
    result = await esbuild.build({
      stdin: {
        contents: entrySource(req.input),
        loader: 'tsx',
        resolveDir: docDir,
        sourcefile: basename(req.docPath),
      },
      absWorkingDir: docDir,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'cw',
      tsconfigRaw: {},
      define: {},
      minify: true,
      legalComments: 'none',
      logLevel: 'silent',
      plugins: [policy],
    });
  } catch (err) {
    return done(describeFailure(err));
  }
  const code = result.outputFiles[0]?.text ?? '';
  if (code.length > MAX_BUNDLE_BYTES) {
    return done(`The built component is ${code.length} bytes, over the ${MAX_BUNDLE_BYTES} limit.`);
  }
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 32);
  return { ok: true, code, hash, watch: [...watch] };
}

/**
 * The `component.json` that declares `file`'s folder, or null. Every place
 * one could be is watched, so adding one rebuilds.
 */
export function declaringManifest(
  file: string,
  workTree: string,
  watch: Set<string>,
): string | null {
  for (let dir = dirname(file); dir.startsWith(workTree + sep); dir = dirname(dir)) {
    const m = join(dir, COMPONENT_MANIFEST);
    watch.add(m);
    if (existsSync(m)) return m;
  }
  return null;
}

/** esbuild's errors as one message for the doc's author. */
function describeFailure(err: unknown): string {
  const errors = (err as { errors?: esbuild.Message[] }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return err instanceof Error ? err.message : String(err);
  }
  return errors
    .slice(0, 3)
    .map((e) => {
      const at = e.location ? ` (${e.location.file}:${e.location.line})` : '';
      return `${e.text}${at}`;
    })
    .join('\n');
}
