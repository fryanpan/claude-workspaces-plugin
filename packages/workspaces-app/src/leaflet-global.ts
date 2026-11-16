/**
 * Leaflet as the global `L`, which GoogleMutant 0.15 extends when it loads
 * (`map-google.ts` imports this first). The map chunk is the only bundle
 * that imports it, and the doc page is the server's own, so the global
 * collides with nothing.
 */
import L from 'leaflet';

(globalThis as { L?: typeof L }).L = L;
