/**
 * The shared kit: the Web Awesome components the trial pages use, imported
 * one by one so the bundle carries only these, plus the compact setting.
 */
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/popover/popover.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { DENSITY_KEY, applyDensity, readDensity } from './density.ts';

applyDensity(
  document.documentElement,
  readDensity(location.search, localStorage.getItem(DENSITY_KEY)),
);
