#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunPlugin } from 'bun';
import { assertBundleExcludes } from './bundle-guard.ts';
import { minifyCss } from './minify-css.ts';
import { assertShimCovers } from './shim-guard.ts';
import { stripSecretShape } from './strip-secret-shape.ts';
import {
  assertReadsNoStrippedField,
  readerCutFor,
  stripUnreadFields,
} from './strip-unread-fields.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');
const shims = join(here, 'shims');

/**
 * The widget ships under a hard gzipped budget (`bun run check:widget-size`),
 * and yjs plus lib0 account for about two thirds of it. The plugins below are
 * the shrinks that do NOT change how a host page loads the widget: they swap
 * two lib0 modules for stand-ins covering the API the bundle actually reads,
 * and minify the stylesheet the bundler otherwise ships verbatim. Each one is
 * documented where it lives; see the shims for what they drop and why.
 */

/**
 * Three modules the widget's dependencies reach for and the widget has no use
 * for on a host page.
 *
 * `lib0/logging` drags `lib0/dom` -> `lib0/schema` (~6.8 KB) in to colourise
 * five yjs console diagnostics, and `lib0/environment` carries env-var and CLI
 * parsing for a single dev-mode check. `y-protocols/awareness` is presence,
 * which the widget renders nowhere and which no reader has ever seen from a
 * widget — its stand-in says what that cost in the meantime. All three resolve
 * to a local stand-in.
 */
// Fail the build rather than ship a shim that is short an export; see
// shim-guard.ts for why a missing one is worse than a build error.
assertShimCovers('lib0/logging', join(shims, 'lib0-logging.js'), pkgRoot);
assertShimCovers('lib0/environment', join(shims, 'lib0-environment.js'), pkgRoot);
assertShimCovers('y-protocols/awareness', join(shims, 'y-protocols-awareness.ts'), pkgRoot);

const guestShims: BunPlugin = {
  name: 'guest-shims',
  setup(build) {
    const replacements: Array<[RegExp, string]> = [
      [/^lib0\/logging$/, join(shims, 'lib0-logging.js')],
      [/^lib0\/environment$/, join(shims, 'lib0-environment.js')],
      // `packages/core/src/ws-client.ts` is the only importer in the widget's
      // graph, and it uses the bare specifier — `y-protocols/sync.js`, the
      // other half of the protocol, does not reach for awareness at all, so
      // there is no relative form to catch the way lib0's modules need.
      [/^y-protocols\/awareness$/, join(shims, 'y-protocols-awareness.ts')],
    ];
    for (const [filter, path] of replacements) {
      build.onResolve({ filter }, () => ({ path }));
    }
    // lib0's own modules reach for these by relative path.
    build.onResolve({ filter: /(^|\/)logging\.js$/ }, (args) =>
      args.importer.includes('/lib0/') ? { path: join(shims, 'lib0-logging.js') } : undefined,
    );
    build.onResolve({ filter: /(^|\/)environment\.js$/ }, (args) =>
      args.importer.includes('/lib0/') ? { path: join(shims, 'lib0-environment.js') } : undefined,
    );
  },
};

const cssMinify: BunPlugin = {
  name: 'widget-css-minify',
  setup(build) {
    // Every stylesheet module, not just the first one: the dock's sheet lives
    // in core (`review-dock-styles.ts`, shared with the doc page) and CSS the
    // minifier never sees is CSS the gzip budget pays for in full.
    const filter =
      /(widget[/\\]src[/\\]styles(-[a-z-]+)?|core[/\\]src[/\\]review-dock-styles)\.ts$/;
    build.onLoad({ filter }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      let hit = false;
      const contents = src.replace(
        /export const (\w+) = `([\s\S]*?)`;/,
        (_m, name: string, css: string) => {
          hit = true;
          return `export const ${name} = \`${minifyCss(css)}\`;`;
        },
      );
      if (!hit) {
        throw new Error(`widget-css-minify: no stylesheet template literal in ${args.path}`);
      }
      return { contents, loader: 'ts' };
    });
  },
};

/**
 * The widget's copy of the thread reader, cut down to what the widget reads.
 *
 * It carries no SECRET shape, and this is where that is made true. What comes
 * out, why it is a deletion rather than a flag, and what it leaves a widget
 * holding a stored secret payload doing, are all in `strip-secret-shape.ts`.
 * It also lifts no thread field the widget never reads (`strip-unread-fields.ts`).
 * Both rewrites throw rather than ship a reader they could not find, and they
 * share one hook because Bun loads a file through the first `onLoad` that
 * matches it.
 */
const threadReaderCuts: BunPlugin = {
  name: 'widget-thread-reader-cuts',
  setup(build) {
    build.onLoad({ filter: /core[/\\]src[/\\](review-item-wire|schema)\.ts$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8');
      if (/review-item-wire\.ts$/.test(args.path)) contents = stripSecretShape(contents, args.path);
      const cut = readerCutFor(args.path);
      if (cut) contents = stripUnreadFields(contents, cut, args.path);
      return { contents, loader: 'ts' };
    });
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

async function build(format: 'esm' | 'iife', name: string, entry: string) {
  const result = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', entry)],
    outdir: dist,
    target: 'browser',
    format: format === 'iife' ? 'iife' : 'esm',
    minify: true,
    sourcemap: 'external',
    plugins: [guestShims, cssMinify, threadReaderCuts],
    naming: {
      entry: name,
    },
  });
  if (!result.success) {
    console.error(`build failed (${format}):`);
    for (const m of result.logs) console.error(m);
    process.exit(1);
  }
  // The bundler ends each file with a `//# debugId=` comment, which a map
  // uploader (sentry-cli) uses to pair the file with its map. Nothing uploads
  // or serves these maps, and every embed paid ~40 B gz of the budget for it.
  // The `.map` files are still written, for reading by hand.
  for (const o of result.outputs) {
    if (o.kind !== 'entry-point') continue;
    writeFileSync(o.path, (await o.text()).replace(/\n+\/\/# debugId=\w+\n*$/, '\n'));
  }
  return result;
}

/**
 * Refuse a widget bundle holding a module it was measured without
 * (`bundle-guard.ts`), or reading a field its thread reader no longer lifts
 * (`strip-unread-fields.ts`).
 */
async function guardWidget(result: Awaited<ReturnType<typeof build>>, name: string) {
  const map = result.outputs.find((o) => o.kind === 'sourcemap');
  if (!map) throw new Error(`widget-bundle-guard: ${name} was built without a source map.`);
  const { sources } = JSON.parse(await map.text()) as { sources?: string[] };
  assertBundleExcludes(sources ?? [], name);
  const entry = result.outputs.find((o) => o.kind === 'entry-point');
  if (!entry) throw new Error(`widget-unread-fields: ${name} has no entry output.`);
  assertReadsNoStrippedField(readFileSync(entry.path, 'utf8'), name);
}

// The ES module is imported for its exports, so it is built from the module
// that has them; the script tag's bundle is built from `widget-iife.ts`, which
// says why it exports nothing.
await guardWidget(await build('esm', 'widget.esm.js', 'widget.ts'), 'widget.esm.js');
await guardWidget(await build('iife', 'widget.iife.js', 'widget-iife.ts'), 'widget.iife.js');
// The mockup live-update script. Its own entrypoint, not part of the widget:
// it runs on ONE surface (a mockup the workspace serves) and it replaces the
// host page's DOM, which the widget — a guest on other people's pages — must
// never do. Separate also keeps it off `check:widget-size`, which measures the
// bundle every embed loads, not this one.
await build('iife', 'mockup-live.js', 'mockup-live.ts');
// The microphone: fetched by an ordinary embed at DOMContentLoaded from the
// few bytes of `widget-mic-inject.ts` that ARE in the budgeted bundle. The
// button, its stylesheet and the first-tap loader are all here instead, which
// is what keeps the budget paying for the fetch and not for the mic.
await build('iife', 'mic.js', 'mic-entry.ts');
// Voice feedback: fetched on the mic's first tap, so it rides on no page that
// never records — and on none of the budgeted bundle's bytes.
await build('iife', 'voice.js', 'voice/voice-entry.ts');
// Edit mode: fetched on the pencil's first tap, or at load when the page has
// edits waiting on the agent. The pencil itself rides in `mic.js` and
// `mockup-live.js`, so neither is on the budgeted bundle.
await build('iife', 'edit.js', 'edit/edit-entry.ts');
// A served mock's sandbox (`server/src/mockup-frame.ts`): the bridge is written
// into the frame's bytes, the host script is loaded by the page holding it.
// Both only ever run on a mock, so neither is on the budgeted bundle.
await build('iife', 'mock-bridge.js', 'mock-bridge.ts');
await build('iife', 'mock-host.js', 'mock-host.ts');

writeFileSync(join(dist, 'BUILD_INFO.txt'), `built ${new Date().toISOString()}\n`);

console.log(`[widget] built to ${dist}`);
