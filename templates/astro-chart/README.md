# Astro chart fixture

Test pages for one question: does a library component run on an Astro page
unchanged? Nothing here is part of the product. `src/pages/index.astro`
answers it for the chart, `packages/core/src/plot-chart.ts`, and
`src/pages/map.astro` for the components package's street map,
`packages/components/src/map.ts`.

The chart page imports the chart file itself and mounts it with
`mountFromSnapshot` (`packages/core/src/component-snapshot.ts`): a state hook
over `src/ferry-state.json`, the JSON `get_component_state` would return for
the doc's chart. The doc half is
`packages/workspaces-app/test/plot-chart-doc-browser.test.ts`.

The map page mounts the map with the package's `mountWithSnapshot` over
`src/harborlight-map-state.json`. It needs no setting: the package imports
Leaflet by name, which this workspace installs. The doc half is
`packages/workspaces-app/test/components-map-doc-browser.test.ts`, and the
same map from the packed tarball on a page with no bundler is
`packages/components/test/static-page-browser.test.ts`.

`astro.config.mjs` maps the esm.sh address the chart imports Plot from to this
package's installed `@observablehq/plot`, the same version. A site that copies
the chart copies `plot-chart.ts` and `plot-spec.mjs` side by side and adds the
same mapping.

```bash
bun install                                          # at the repo root
CW_BROWSER_TESTS=1 bunx vitest run templates/astro-chart   # builds, opens headless Chrome
```
