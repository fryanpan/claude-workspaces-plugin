import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  componentBuildKey,
  componentBuildOf,
  componentInputs,
  componentTagIds,
  importKind,
  mdxFlowSources,
  parseImports,
} from './mdx-components.ts';
import { getProseFragment, parseMarkdownBlocks } from './prose.ts';

describe('which tags are component tags', () => {
  it('reads every binding an import makes', () => {
    const [i] = parseImports("import Map, { Pin as P, type Bounds, scale } from './map/index.ts';");
    expect(i?.names.sort()).toEqual(['Map', 'P', 'scale']);
    expect(parseImports("import * as d3 from 'https://esm.sh/d3@7.9.0'")[0]?.names).toEqual(['d3']);
    expect(parseImports("import type { X } from './x.ts'")).toEqual([]);
  });

  it('sorts specifiers into what the server builds, refuses, or leaves alone', () => {
    expect(importKind('./carousel.tsx')).toBe('local');
    expect(importKind('../components/x.js')).toBe('local');
    expect(importKind('https://esm.sh/d3@7.9.0')).toBe('cdn');
    expect(importKind('leaflet')).toBe('bare');
    expect(importKind('../components/Chart.astro')).toBe('other');
    expect(importKind('astro:content')).toBe('other');
  });

  it('names a tag that uses a buildable or bare import, with only the imports it uses', () => {
    const blocks = [
      "import Carousel from './components/carousel.tsx'\nimport Hero from './Hero.astro'\nimport L from 'leaflet'",
      '<Carousel>\n  <PlotChart marks={[]} />\n</Carousel>',
      '<Hero title="Harborlight" />',
      '<PlotChart marks={[]} />',
      '<L />',
    ];
    const tags = componentInputs(blocks);
    expect(tags.map((t) => t.tag)).toEqual([blocks[1], blocks[4]]);
    expect(tags[0]?.imports).toEqual(["import Carousel from './components/carousel.tsx'"]);
    expect(tags[1]?.imports).toEqual(["import L from 'leaflet'"]);
  });

  it('keys a build by its imports and its tag, so either changing moves the key', () => {
    const a = componentBuildKey(["import A from './a.tsx'"], '<A />');
    expect(a).toMatch(/^[a-f0-9]{28}$/);
    expect(componentBuildKey(["import A from './a.tsx'"], '<A />')).toBe(a);
    expect(componentBuildKey(["import A from './b.tsx'"], '<A />')).not.toBe(a);
    expect(componentBuildKey(["import A from './a.tsx'"], '<A x="1" />')).not.toBe(a);
  });
});

describe('the blocks the server reads', () => {
  it('are the mdx-flow blocks of the fragment, in order, as their exact text', () => {
    const ydoc = new Y.Doc();
    const md =
      '# Riverbend\n\nimport Ferry from \'./f.tsx\'\n\nSaltmarsh words.\n\n<Ferry\n  route="Harborlight"\n/>\n';
    getProseFragment(ydoc).push(parseMarkdownBlocks(md, { mdx: true }));
    expect(mdxFlowSources(getProseFragment(ydoc))).toEqual([
      "import Ferry from './f.tsx'",
      '<Ferry\n  route="Harborlight"\n/>',
    ]);
  });

  it('reads a recorded build, and nothing that is not one', () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap('componentBuilds');
    map.set('k', { hash: 'f'.repeat(32), at: 1 });
    map.set('bad', { hash: '../x', at: 1 });
    map.set('junk', 'nope');
    expect(componentBuildOf(map, 'k')).toEqual({ hash: 'f'.repeat(32), at: 1 });
    expect(componentBuildOf(map, 'bad')).toEqual({ at: 1 });
    expect(componentBuildOf(map, 'junk')).toBeUndefined();
  });
});

describe('the state ids a tag names', () => {
  it("reads each function tag's literal id once, in order, and nothing else", () => {
    const tag =
      '<Map id="map" zoom={12}>\n  <Pin id=\'harbor\' />\n  <Pin id={"saltmarsh"} />\n  <Pin id={`riverbend`} />\n  <div id="plain" />\n  <Pin id={name} />\n  <Pin id="map" />\n</Map>';
    expect(componentTagIds(tag)).toEqual(['map', 'harbor', 'saltmarsh', 'riverbend']);
    expect(componentTagIds('<Map zoom={12} />')).toEqual([]);
  });
});
