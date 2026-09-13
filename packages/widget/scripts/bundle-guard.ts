/**
 * Modules the widget bundle must not contain, and the check that refuses one.
 *
 * `check:widget-size` sees one number, so it cannot say what grew — and every
 * module below came back in, or first arrived, without anyone choosing to add
 * it: one import that reaches a barrel, a namespace object or a logging helper
 * is enough, and the ceiling only notices once the next person's six bytes tip
 * it over. Each entry here was measured out of the bundle once. The build reads
 * the source map of what it just wrote and fails naming the module and the
 * reason, so a regrowth is caught by the change that causes it.
 *
 * Matched against the map's `sources`, which Bun writes relative to the output
 * directory (`../../core/src/anchor/validate.ts`,
 * `../../../node_modules/.bun/lib0@…/node_modules/lib0/schema.js`), so each
 * pattern is a path suffix that holds whatever the prefix is.
 */
export const EXCLUDED_MODULES: ReadonlyArray<{ module: string; why: string }> = [
  {
    module: 'core/src/anchor/index.ts',
    why:
      'the anchor barrel. Imported as a namespace (`anchors` off the core index) ' +
      'it keeps every module behind it; import the leaf the widget calls, ' +
      '`@claude-workspaces/core/anchor/element` or `/anchor/context`.',
  },
  {
    module: 'core/src/anchor/text-range.ts',
    why: 'text-range anchors belong to the review editor; the widget pins elements.',
  },
  {
    module: 'core/src/anchor/validate.ts',
    why: 'the anchor validator is for the server and the editor, and reaches yjs position code.',
  },
  {
    module: 'core/src/review-item-secret-wire.ts',
    why: 'the widget renders no secret ask (`strip-secret-shape.ts`).',
  },
  {
    module: 'core/src/review-judge-prompt.ts',
    why: 'the wording of a server-side model prompt.',
  },
  {
    module: 'lib0/schema.js',
    why: 'reached only through lib0/logging, which the widget swaps for a shim.',
  },
  {
    module: 'lib0/dom.js',
    why: 'reached only through lib0/logging, which the widget swaps for a shim.',
  },
];

/**
 * Throw when the bundle's source map names an excluded module. `bundle` names
 * the output in the message. Reading zero sources is an error too: a map this
 * could not read would otherwise pass every bundle.
 */
export function assertBundleExcludes(
  sources: readonly string[],
  bundle: string,
  excluded = EXCLUDED_MODULES,
): void {
  if (sources.length === 0) {
    throw new Error(`widget-bundle-guard: ${bundle} has a source map naming no sources.`);
  }
  const found = excluded.filter(({ module }) =>
    sources.some((s) => s.replaceAll('\\', '/').endsWith(`/${module}`)),
  );
  if (found.length === 0) return;
  throw new Error(
    `widget-bundle-guard: ${bundle} contains ${found.length === 1 ? 'a module' : 'modules'} ` +
      `it must not:\n${found.map(({ module, why }) => `  - ${module}: ${why}`).join('\n')}`,
  );
}
