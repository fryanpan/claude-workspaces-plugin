/**
 * The esm.sh address `plot-chart.ts` imports Plot from. A doc build fetches
 * it from esm.sh; vitest and a site's bundler map it to the installed
 * `@observablehq/plot` 0.6.17. Typed only as far as `plot-spec.mjs` reads it:
 * an object of Plot's functions, which it looks up by name.
 */
declare module 'https://esm.sh/@observablehq/plot@0.6.17' {
  const plot: (options: Record<string, unknown>) => Element;
  export { plot };
}
