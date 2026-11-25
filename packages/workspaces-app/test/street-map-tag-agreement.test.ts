import {
  mapBasemapNames,
  mapDataPaths,
  mapDataSegments,
  readMapSpec,
} from '@claude-workspaces/core/map-spec';
import { describe, expect, it } from 'vitest';
import { summarizeMdx } from '../src/mdx-preview.ts';

/**
 * The page and the server read a `<StreetMap>` tag with one reader, so the
 * data file the page fetches for a tag is the file the server serves a visitor
 * for that doc (`doc-file-scope.ts` via `mapDataPaths`), and the basemap the
 * page asks a key for is one the server hands it (`mapBasemapNames`). Each
 * variant is fed to both sides and their answers must match, whatever they
 * are: a disagreement is either a map the page cannot draw or a file the
 * server serves that no map on the page reads.
 */

const SRC_VARIANTS: Record<string, string> = {
  'double quotes': '<StreetMap src="data/reports.json" />',
  'single quotes': "<StreetMap src='./riverbend.json' />",
  'a string in braces': '<StreetMap src={"harborlight.json"} />',
  'a template in braces': '<StreetMap src={`saltmarsh.json`} />',
  'an expression in braces': '<StreetMap src={file} />',
  multiline:
    '<StreetMap\n  title="Saltmarsh"\n  src=\n    "data/saltmarsh.json"\n  rings={[150, 300]}\n/>',
  'self-closing with no space': '<StreetMap src="a.json"/>',
  'with children': '<StreetMap src="kids.json">\n  Reports near Harborlight\n</StreetMap>',
  'a > inside an earlier prop':
    '<StreetMap markers={[{ lat: 1, lng: 2, popup: "a > b" }]} src="later.json" />',
  'src inside another prop': '<StreetMap title="src=\\"inner.json\\"" />',
  'an escaped quote in src': '<StreetMap src="we\\"ird.json" />',
  'a comment before src': '<StreetMap /* note */ src="commented.json" />',
  'never closed': '<StreetMap src="open.json"',
  'an unterminated string before src': '<StreetMap title="Alice src="b.json" />',
  'bare src attribute': '<StreetMap src />',
  'no src': '<StreetMap markers={[{ lat: 1, lng: 2 }]} />',
  'a longer tag name': '<StreetMapLegend src="legend.json" />',
  'climbs out': '<StreetMap src="../up.json" />',
  'not json': '<StreetMap src="notes.txt" />',
};

/** The file the page fetches for `block`, as path segments. */
function pageSrc(block: string): string[][] {
  const src = summarizeMdx(block).map?.src;
  const segs = src === undefined ? null : mapDataSegments(src);
  return segs ? [segs] : [];
}

/** The basemap the page asks the server's key for, if it draws a map. */
function pageBasemap(block: string): string[] {
  const { map, error } = summarizeMdx(block);
  // A prop that is not a literal stops the page drawing the map at all.
  if (!map || error || map.unreadable.length > 0) return [];
  const read = readMapSpec({ markers: [{ lat: 1, lng: 2 }], ...map.props });
  return read.ok ? [read.spec.basemap] : [];
}

describe('a <StreetMap> tag read by the page and by the server', () => {
  it.each(Object.entries(SRC_VARIANTS))('names the same data file: %s', (_, block) => {
    expect(mapDataPaths([block])).toEqual(pageSrc(block));
  });

  it('agrees on a src written as a plain string literal in braces', () => {
    // The case the two readers used to split on: the page fetched it, and the
    // server refused to serve it.
    expect(mapDataPaths(['<StreetMap src={"harborlight.json"} />'])).toEqual([
      ['harborlight.json'],
    ]);
  });

  const BASEMAP_VARIANTS: Record<string, string> = {
    'double quotes': '<StreetMap basemap="carto-light" />',
    'single quotes': "<StreetMap basemap='osm' />",
    'a string in braces': '<StreetMap basemap={"osm"} />',
    'an expression in braces': '<StreetMap basemap={name} />',
    'none named': '<StreetMap src="a.json" />',
    'basemap inside another prop': '<StreetMap title="basemap=\\"osm\\"" />',
    multiline: '<StreetMap\n  basemap=\n  "osm"\n/>',
    'a longer prop name': '<StreetMap basemapStyle="dark" />',
    'never closed': '<StreetMap basemap="osm"',
    'nothing named, never closed': '<StreetMap src="a.json"',
  };

  it.each(Object.entries(BASEMAP_VARIANTS))('names the same basemap: %s', (_, block) => {
    expect(mapBasemapNames([block])).toEqual(pageBasemap(block));
  });
});
