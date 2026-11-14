# Astro chart fixture

A test page for one question: does the library chart,
`packages/core/src/plot-chart.ts`, run on an Astro page unchanged? Nothing
here is part of the product.

The page imports the chart file itself and mounts it with
`mountFromSnapshot` (`packages/core/src/component-snapshot.ts`): a state hook
over `src/ferry-state.json`, the JSON `get_component_state` would return for
the doc's chart. The doc half is
`packages/workspaces-app/test/plot-chart-doc-browser.test.ts`.

`astro.config.mjs` maps the esm.sh address the chart imports Plot from to this
package's installed `@observablehq/plot`, the same version. A site that copies
the chart copies `plot-chart.ts` and `plot-spec.mjs` side by side and adds the
same mapping.

```bash
bun install                                          # at the repo root
CW_BROWSER_TESTS=1 bunx vitest run templates/astro-chart   # builds, opens headless Chrome
```
