/**
 * The `layers` prop is judged before anything draws: each layer's fields
 * are read with their defaults and ranges, a field it cannot read names the
 * layer and the field, and a layer's GeoJSON is checked against its kind
 * and the map's caps.
 */
import { describe, expect, it } from 'vitest';
import {
  HEAT_COLORS,
  LAYER_LIMITS,
  emptyBudget,
  layerUrlAllowed,
  popupText,
  readLayerData,
  readLayers,
} from '../src/layers.ts';

const line = (coords: number[][], properties: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties,
});
const RIVERBEND_PATHS = {
  type: 'FeatureCollection',
  features: [
    line(
      [
        [-122.44, 37.76],
        [-122.43, 37.77],
      ],
      { name: 'Riverbend Ave', speed: 25 },
    ),
    { type: 'Feature', geometry: null, properties: { name: 'retired' } },
  ],
};

function only<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('readLayers', () => {
  it('reads a line layer with its defaults, and the fields it is given', () => {
    const [plain, styled] = only(
      readLayers([
        { type: 'line', data: RIVERBEND_PATHS },
        {
          type: 'line',
          id: 'paths',
          name: 'Riverbend paths',
          url: './paths.geojson',
          color: '#ff725c',
          width: 40,
          opacity: 0.5,
          dash: [6, 4],
          popup: '{name}',
          visible: false,
        },
      ]),
    );
    expect(plain).toMatchObject({
      type: 'line',
      id: 'layer-0',
      name: 'layer-0',
      color: '#4269d0',
      width: 2,
      opacity: 0.9,
      visible: true,
      source: { data: RIVERBEND_PATHS },
    });
    expect(plain?.type === 'line' && plain.dash).toBeFalsy();
    // A width past the range is held at its edge, not refused.
    expect(styled).toMatchObject({
      id: 'paths',
      name: 'Riverbend paths',
      width: 20,
      opacity: 0.5,
      dash: '6 4',
      popup: '{name}',
      visible: false,
      source: { url: './paths.geojson' },
    });
  });

  it('reads a polygon layer whose outline defaults to its fill', () => {
    const [quarter] = only(
      readLayers([{ type: 'polygon', name: 'Saltmarsh quarter', data: {}, fill: 'rebeccapurple' }]),
    );
    expect(quarter).toMatchObject({
      fill: 'rebeccapurple',
      fillOpacity: 0.25,
      outline: 'rebeccapurple',
      outlineWidth: 1,
    });
  });

  it('reads a heatmap layer with the default ramp', () => {
    const [heat] = only(readLayers([{ type: 'heatmap', data: [], weight: 'count', radius: 1 }]));
    expect(heat).toMatchObject({
      type: 'heatmap',
      weight: 'count',
      radius: 2,
      intensity: 1,
      opacity: 0.8,
      colors: [...HEAT_COLORS],
    });
  });

  it.each([
    ['not a list', { type: 'line' }, 'layers must be a list'],
    ['an unknown type', [{ type: 'raster', data: [] }], 'layers[0].type must be'],
    ['no data', [{ type: 'line' }], 'layers[0] needs data or a url, not both'],
    ['data and a url', [{ type: 'line', data: [], url: 'a.json' }], 'not both'],
    ['a script URL', [{ type: 'line', url: 'javascript:alert(1)' }], 'layers[0].url must be'],
    [
      'a colour that is markup',
      [{ type: 'line', data: [], color: '"><b>' }],
      'layers[0].color must be a colour',
    ],
    [
      'a width that is text',
      [{ type: 'line', data: [], width: 'wide' }],
      'layers[0].width must be a number',
    ],
    ['a dash of zeroes', [{ type: 'line', data: [], dash: [0] }], 'layers[0].dash must be'],
    [
      'a one-colour ramp',
      [{ type: 'heatmap', data: [], colors: ['#fff'] }],
      'layers[0].colors must be',
    ],
    [
      'an id used twice',
      [
        { type: 'line', id: 'a', data: [] },
        { type: 'line', id: 'a', data: [] },
      ],
      'is used twice',
    ],
  ])('refuses %s', (_, layers, error) => {
    const r = readLayers(layers);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(error);
  });

  it('refuses more layers than a map draws', () => {
    const many = Array.from({ length: LAYER_LIMITS.layers + 1 }, () => ({
      type: 'line',
      data: [],
    }));
    expect(readLayers(many)).toEqual({ ok: false, error: 'a map draws at most 24 layers' });
  });
});

describe('readLayerData', () => {
  const lineLayer = only(readLayers([{ type: 'line', name: 'Riverbend paths', data: null }]))[0];
  const heatLayer = only(
    readLayers([{ type: 'heatmap', name: 'Harborlight reports', data: null, weight: 'count' }]),
  )[0];
  if (!lineLayer || !heatLayer) throw new Error('layers did not read');

  it('takes a FeatureCollection, skips a null geometry and counts vertices', () => {
    const budget = emptyBudget();
    const data = only(readLayerData(lineLayer, RIVERBEND_PATHS, budget));
    expect(data.kind).toBe('paths');
    expect(data.kind === 'paths' && data.features).toHaveLength(1);
    expect(budget).toEqual({ features: 1, vertices: 2, heatPoints: 0 });
  });

  it('takes a bare geometry and a list of features', () => {
    const geometry = {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    };
    expect(only(readLayerData(lineLayer, geometry, emptyBudget()))).toMatchObject({ vertices: 4 });
    expect(only(readLayerData(lineLayer, RIVERBEND_PATHS.features, emptyBudget()))).toMatchObject({
      vertices: 2,
    });
  });

  it('refuses a geometry of another kind, naming the layer and the feature', () => {
    const point = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    };
    expect(
      readLayerData(
        lineLayer,
        [
          line([
            [0, 0],
            [1, 1],
          ]),
          point,
        ],
        emptyBudget(),
      ),
    ).toEqual({
      ok: false,
      error:
        'layer "Riverbend paths": feature 1 is a Point; a line layer draws LineString and MultiLineString',
    });
  });

  it('refuses a position out of range, and what is not GeoJSON', () => {
    expect(
      readLayerData(
        lineLayer,
        [
          line([
            [0, 0],
            [200, 1],
          ]),
        ],
        emptyBudget(),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('feature 0 has a position that is not [lng, lat]'),
    });
    expect(readLayerData(lineLayer, 'Harborlight', emptyBudget())).toEqual({
      ok: false,
      error: 'layer "Riverbend paths" is not GeoJSON',
    });
  });

  it('reads heatmap weights from the named property, a missing one as nothing', () => {
    const reports = [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122.44, 37.76] },
        properties: { count: 3 },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [-122.43, 37.77],
            [-122.42, 37.78],
          ],
        },
        properties: {},
      },
    ];
    const data = only(readLayerData(heatLayer, reports, emptyBudget()));
    expect(data).toEqual({
      kind: 'heat',
      points: [
        { lat: 37.76, lng: -122.44, weight: 3 },
        { lat: 37.77, lng: -122.43, weight: 0 },
        { lat: 37.78, lng: -122.42, weight: 0 },
      ],
      bbox: [-122.44, 37.76, -122.42, 37.78],
    });
  });

  it('refuses a layer that takes the map past its cap, counting earlier layers', () => {
    const budget = { features: LAYER_LIMITS.features, vertices: 0, heatPoints: 0 };
    const r = readLayerData(lineLayer, RIVERBEND_PATHS, budget);
    expect(r).toEqual({
      ok: false,
      error: `layer "Riverbend paths" brings the map's line and polygon features to 50001; a map draws at most 50000`,
    });
    expect(budget.features).toBe(LAYER_LIMITS.features);
  });
});

describe('popupText', () => {
  it('fills each {key} from the properties as text, and an absent one empty', () => {
    expect(popupText('{name}: {speed} mph{missing}', { name: '<b>Riverbend</b>', speed: 25 })).toBe(
      '<b>Riverbend</b>: 25 mph',
    );
    expect(popupText('{ name }', { name: 'Saltmarsh', nested: { a: 1 } })).toBe('Saltmarsh');
    expect(popupText('{nested}', { nested: { a: 1 } })).toBe('');
  });
});

describe('layerUrlAllowed', () => {
  it('takes a path on the site and http(s), and nothing else', () => {
    for (const ok of [
      'paths.geojson',
      './data/paths.json',
      '/data/x.json',
      'https://example.org/a.json',
    ]) {
      expect(layerUrlAllowed(ok), ok).toBe(true);
    }
    for (const no of [
      '',
      'javascript:alert(1)',
      'data:application/json,{}',
      '//elsewhere.org/a',
      'file:///etc/x',
    ]) {
      expect(layerUrlAllowed(no), no).toBe(false);
    }
  });
});
