/**
 * Leaflet as the global `L`, which GoogleMutant 0.15 extends when it loads
 * (`google.ts` imports this first). On the board the map chunk is the only
 * bundle that imports it. On a site it replaces any Leaflet global the page
 * already had.
 */
import L from 'leaflet';

(globalThis as { L?: typeof L }).L = L;
