// The Astro page that proves the library chart (core/plot-chart.ts) runs
// unchanged off the doc. The one setting: the chart imports Plot from the
// esm.sh address a doc build accepts, and this page bundles its own installed
// copy of the same version for that address.
import { createRequire } from 'node:module';
import { defineConfig } from 'astro/config';

const PLOT_FROM_ESM_SH = 'https://esm.sh/@observablehq/plot@0.6.17';
const installedPlot = createRequire(import.meta.url).resolve('@observablehq/plot');

export default defineConfig({
  vite: {
    plugins: [
      {
        name: 'plot-from-esm-sh',
        enforce: 'pre',
        resolveId: (id) => (id === PLOT_FROM_ESM_SH ? installedPlot : null),
      },
    ],
  },
});
