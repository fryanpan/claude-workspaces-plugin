/**
 * Compile the kit's TypeScript source into the JavaScript and declaration
 * files the packed package ships, so an app outside this repo imports plain
 * `.js` with `.d.ts` beside it. Its own tsconfig then needs no
 * `allowImportingTsExtensions`, and the kit's source is not typechecked
 * under the app's settings.
 *
 * `scripts/pack.ts` runs it on its staging folder. Relative `.ts` imports
 * become `.js`: the compiler rewrites them in the JavaScript
 * (`rewriteRelativeImportExtensions`) and `declarationSpecifiers` in the
 * declarations, which it leaves as written.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const PKG_ROOT = resolve(import.meta.dirname, '..');

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // The page client binds a <textarea>; nothing on the server path imports it.
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
  strict: true,
  declaration: true,
  rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  newLine: ts.NewLineKind.LineFeed,
};

/** A declaration file's relative `.ts` specifiers, as `.js`. */
export function declarationSpecifiers(text: string): string {
  return text.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
}

const writeOut: ts.WriteFileCallback = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, path.endsWith('.d.ts') ? declarationSpecifiers(text) : text);
};

/** Compile every `.ts` file under `<root>/src` into `<root>/lib`. Throws
 *  with the compiler's messages if anything fails to typecheck. */
export function compileLib(root: string, files: string[]): void {
  // The source imports yjs, y-protocols and lib0: borrow this package's
  // install for the compile, and take it away before anything is packed.
  const modules = join(root, 'node_modules');
  const borrowed = !existsSync(modules);
  if (borrowed) symlinkSync(join(PKG_ROOT, 'node_modules'), modules, 'dir');
  try {
    const program = ts.createProgram(files, {
      ...OPTIONS,
      rootDir: join(root, 'src'),
      outDir: join(root, 'lib'),
    });
    const emitted = program.emit(undefined, writeOut);
    const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
    if (problems.length > 0 || emitted.emitSkipped) {
      const host: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      };
      throw new Error(`the kit failed to compile:\n${ts.formatDiagnostics(problems, host)}`);
    }
  } finally {
    if (borrowed) unlinkSync(modules);
  }
}
