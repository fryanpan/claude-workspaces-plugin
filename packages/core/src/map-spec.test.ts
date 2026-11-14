import { describe, expect, it } from 'vitest';
import { BASEMAPS, DEFAULT_BASEMAP, basemapOf } from './map-basemaps.ts';
import {
  CATEGORY_COLORS,
  FEET_TO_METERS,
  mapDataPaths,
  mergeMapData,
  readMapSpec,
} from './map-spec.ts';

describe('a StreetMap tag read into a spec', () => {
  it('reads markers, rings in feet, and category-coloured points with a legend', () => {
    const out = readMapSpec({
      markers: [{ lat: 37.77, lng: -122.42, label: 'Harborlight', popup: 'Harborlight hall' }],
      rings: [150, 300],
      points: [
        { lat: 37.771, lng: -122.421, category: 'Noise' },
        { lat: 37.772, lon: -122.422, category: 'Litter' },
        { latitude: 37.773, longitude: -122.423, category: 'Noise' },
      ],
    });
    if (!out.ok) throw new Error(out.error);
    const { spec } = out;
    expect(spec.markers).toHaveLength(1);
    expect(spec.markers[0]?.popup).toBe('Harborlight hall');
    expect(spec.rings.map((r) => r.meters)).toEqual([150 * FEET_TO_METERS, 300 * FEET_TO_METERS]);
    expect(spec.rings.map((r) => r.label)).toEqual(['150 ft', '300 ft']);
    expect(spec.points.map((p) => p.lng)).toEqual([-122.421, -122.422, -122.423]);
    // Colours follow first appearance, from the same palette PlotChart uses.
    expect(spec.categories).toEqual([
      { name: 'Noise', color: CATEGORY_COLORS[0] },
      { name: 'Litter', color: CATEGORY_COLORS[1] },
    ]);
    expect(spec.points.map((p) => p.color)).toEqual([
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[1],
      CATEGORY_COLORS[0],
    ]);
    expect(spec.legend).toBe(true);
    expect(spec.basemap).toBe(DEFAULT_BASEMAP);
  });

  it('takes the author’s colours and order, and ignores a colour that is not hex', () => {
    const out = readMapSpec({
      categories: { Litter: '#123456', Noise: 'url(javascript:1)' },
      points: [
        { lat: 1, lng: 1, category: 'Noise' },
        { lat: 1, lng: 1, category: 'Litter' },
      ],
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.spec.categories.map((c) => c.name)).toEqual(['Litter', 'Noise']);
    expect(out.spec.categories[0]?.color).toBe('#123456');
    expect(out.spec.categories[1]?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('accepts rings written as objects with their own colour and label', () => {
    const out = readMapSpec({
      markers: [{ lat: 1, lng: 2 }],
      rings: [{ feet: 150, color: '#aa0000', label: 'Close' }, { meters: 100 }],
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.spec.rings).toEqual([
      { meters: 150 * FEET_TO_METERS, label: 'Close', color: '#aa0000' },
      { meters: 100, label: '100 m', color: expect.any(String) },
    ]);
  });

  it('refuses what it cannot draw, and says which row', () => {
    const bad = readMapSpec({
      markers: [
        { lat: 1, lng: 2 },
        { lat: 'x', lng: 2 },
      ],
    });
    expect(bad).toEqual({ ok: false, error: 'markers[1] needs a numeric lat and lng' });
    expect(readMapSpec({ points: [{ lat: 95, lng: 0 }] }).ok).toBe(false);
    expect(readMapSpec({ basemap: 'google' })).toEqual({
      ok: false,
      error: `basemap "google" is not one of: ${Object.keys(BASEMAPS).join(', ')}`,
    });
    expect(readMapSpec({})).toEqual({
      ok: false,
      error: 'A StreetMap needs markers or points, inline or in its src file',
    });
  });

  it('reads the view, height and legend switches', () => {
    const out = readMapSpec({
      points: [{ lat: 1, lng: 2 }],
      center: [37.7, -122.4],
      zoom: 14,
      height: 300,
      legend: false,
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.spec.center).toEqual([37.7, -122.4]);
    expect(out.spec.zoom).toBe(14);
    expect(out.spec.height).toBe(300);
    expect(out.spec.legend).toBe(false);
  });

  it('takes data from the src file wherever the tag leaves it out', () => {
    const merged = mergeMapData(
      { rings: [150], title: 'Riverbend' },
      { markers: [{ lat: 1, lng: 2 }], rings: [999], points: [] },
    );
    expect(merged).toEqual({
      rings: [150],
      title: 'Riverbend',
      markers: [{ lat: 1, lng: 2 }],
      points: [],
    });
    // A file is data, not a place to pick the basemap or the page's layout.
    expect(mergeMapData({}, { basemap: 'x', height: 2000 })).toEqual({});
  });
});

describe('the files a doc’s StreetMap tags name', () => {
  it('lists each src as segments relative to the doc', () => {
    expect(
      mapDataPaths([
        "import X from './x.ts'",
        '<StreetMap src="data/311.json" rings={[150]} />',
        '<StreetMap title="Saltmarsh" src=\'./saltmarsh.json\' />',
        '<PlotChart src="nope.json" />',
        '<StreetMap src="../up.json" />',
        '<StreetMap src="/abs.json" />',
        '<StreetMap src="notes.txt" />',
        '<StreetMap src={"computed.json"} />',
        '<Wrap>\n  <StreetMap markers={[{ lat: 1, lng: 2, popup: "a > b" }]} src="later.json" />\n</Wrap>',
      ]),
    ).toEqual([['data', '311.json'], ['saltmarsh.json'], ['later.json']]);
  });
});

describe('the basemap seam', () => {
  it('names one keyless default, and every entry lists the origins it loads from', () => {
    const base = basemapOf(DEFAULT_BASEMAP);
    expect(base?.key).toBeUndefined();
    for (const b of Object.values(BASEMAPS)) {
      expect(b.attribution.length).toBeGreaterThan(0);
      expect(b.origins.length).toBeGreaterThan(0);
      const host = new URL(b.tiles.replace(/\{[a-z]\}/g, 'a')).origin;
      expect(b.origins).toContain(host);
    }
    expect(basemapOf('nope')).toBeUndefined();
  });
});
