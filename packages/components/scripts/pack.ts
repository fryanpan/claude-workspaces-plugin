#!/usr/bin/env bun
/**
 * Pack `@claude-workspaces/components` into a tarball a site outside this
 * repo installs: `bun run --cwd packages/components pack [outDir]`.
 *
 * The package's own source imports five files of `packages/core/src` by
 * package name. The packed copy carries those files under `src/core/` and
 * points the imports at them, so nothing in the tarball names this repo.
 *
 * Then it builds the JavaScript and the declarations into `lib/`:
 *
 *  - the JavaScript with Bun's bundler, one module per entry in `ENTRIES`
 *    and shared chunks beside them, with Leaflet and GoogleMutant inside. So
 *    the package has no dependencies, installs from the tarball alone, and
 *    a page with no bundler imports `lib/map.js` as it is;
 *  - the declarations with the TypeScript compiler, one `.d.ts` per source
 *    file, with relative `.ts` specifiers rewritten to `.js`.
 *
 * Each entry becomes `{ types, default }` in the packed `package.json`; the
 * in-repo entries the board alone uses (`./draw`, `./placed`) are not
 * exported. The version is the one in `package.json`; the tarball is
 * `claude-workspaces-components-<version>.tgz`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(PKG_ROOT, '../..');
const CORE_SRC = join(REPO, 'packages/core/src');

/** The entries a site imports: export path to the source file's name. */
export const ENTRIES: Record<string, string> = { '.': 'index', './map': 'map' };

/** The core files the package's source reaches, carried in `src/core/`. */
export const CORE_FILES = [
  'component-snapshot.ts',
  'component-state-rules.ts',
  'map-basemaps.ts',
  'map-spec.ts',
  'mdx-component-runtime.ts',
  'tag-props.ts',
];

interface Manifest {
  name: string;
  version: string;
  description: string;
  license: string;
}

export function componentsManifest(): Manifest {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Manifest;
}

/** The tarball's file name for a version, as `bun pm pack` writes it. */
export function tarballName(version: string): string {
  return `claude-workspaces-components-${version}.tgz`;
}

/** `text` with its `@claude-workspaces/core/<name>` imports pointed at
 *  `./core/<name>.ts`. */
export function localCoreImports(text: string): string {
  return text.replace(/(['"])@claude-workspaces\/core\/([\w-]+)\1/g, '$1./core/$2.ts$1');
}

/** A declaration file's relative `.ts` specifiers, as `.js`. */
export function declarationSpecifiers(text: string): string {
  return text.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
}

function writeDeclarations(stage: string): void {
  const src = join(stage, 'src');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(src, f));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    declaration: true,
    emitDeclarationOnly: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    rootDir: src,
    outDir: join(stage, 'lib'),
    newLine: ts.NewLineKind.LineFeed,
  });
  const emitted = program.emit(undefined, (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, declarationSpecifiers(text));
  });
  const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (problems.length > 0 || emitted.emitSkipped) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => stage,
      getNewLine: () => '\n',
    };
    throw new Error(`the package failed to compile:\n${ts.formatDiagnostics(problems, host)}`);
  }
}

async function writeModules(stage: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: Object.values(ENTRIES).map((name) => join(stage, 'src', `${name}.ts`)),
    outdir: join(stage, 'lib'),
    root: join(stage, 'src'),
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: true,
    naming: { entry: '[name].js', chunk: 'chunk-[hash].js' },
  });
  if (!built.success) {
    throw new Error(`the package failed to bundle:\n${built.logs.map(String).join('\n')}`);
  }
}

/** Pack into `outDir`; returns the tarball's path. */
export async function packComponents(outDir: string): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), 'components-pack-'));
  try {
    const { name, version, description, license } = componentsManifest();
    const src = join(stage, 'src');
    mkdirSync(join(src, 'core'), { recursive: true });
    for (const file of readdirSync(join(PKG_ROOT, 'src'))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(PKG_ROOT, 'src', file), 'utf8');
      writeFileSync(join(src, file), localCoreImports(text));
    }
    for (const file of CORE_FILES) cpSync(join(CORE_SRC, file), join(src, 'core', file));
    // Leaflet, GoogleMutant and Leaflet's types, from this package's install,
    // for the build only; nothing under node_modules is packed.
    symlinkSync(join(PKG_ROOT, 'node_modules'), join(stage, 'node_modules'), 'dir');

    writeDeclarations(stage);
    await writeModules(stage);
    rmSync(src, { recursive: true });
    rmSync(join(stage, 'node_modules'));

    const exports = Object.fromEntries(
      Object.entries(ENTRIES).map(([path, file]) => [
        path,
        { types: `./lib/${file}.d.ts`, default: `./lib/${file}.js` },
      ]),
    );
    const manifest = {
      name,
      version,
      description,
      license,
      type: 'module',
      exports,
      files: ['lib', 'README.md', 'LICENSE'],
    };
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    cpSync(join(PKG_ROOT, 'README.md'), join(stage, 'README.md'));
    cpSync(join(REPO, 'LICENSE'), join(stage, 'LICENSE'));

    mkdirSync(outDir, { recursive: true });
    const out = resolve(outDir);
    const run = spawnSync('bun', ['pm', 'pack', '--destination', out, '--quiet'], {
      cwd: stage,
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`bun pm pack failed:\n${run.stdout}\n${run.stderr}`);
    return join(out, tarballName(version));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(await packComponents(process.argv[2] ?? join(PKG_ROOT, 'dist')));
}
