/**
 * The compact setting. It is a per-device preference (CLAUDE.md: width
 * cannot identify a device), so it is read from storage, never from a media
 * query. The query parameter lets a headless run set it without storage.
 */
export type Density = 'compact' | 'comfortable';

export const DENSITY_KEY = 'kit-density';

export function readDensity(search: string, stored: string | null): Density {
  const fromQuery = new URLSearchParams(search).get('density');
  return (fromQuery ?? stored) === 'compact' ? 'compact' : 'comfortable';
}

export function applyDensity(root: HTMLElement, density: Density): void {
  if (density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
}
