/**
 * The shared kit: the Web Awesome components the trial pages use, imported
 * one by one so the bundle carries only these, plus the compact setting.
 *
 * Compact is a per-device preference (CLAUDE.md: width cannot identify a
 * device), so it is read from storage, never from a media query. The query
 * parameter exists so a headless run can set it without touching storage.
 */
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/popover/popover.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

export const DENSITY_KEY = 'kit-density';

export function readDensity(search: string, stored: string | null): 'compact' | 'comfortable' {
  const fromQuery = new URLSearchParams(search).get('density');
  const value = fromQuery ?? stored;
  return value === 'compact' ? 'compact' : 'comfortable';
}

export function applyDensity(root: HTMLElement, density: 'compact' | 'comfortable'): void {
  if (density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
}

applyDensity(
  document.documentElement,
  readDensity(location.search, localStorage.getItem(DENSITY_KEY)),
);
