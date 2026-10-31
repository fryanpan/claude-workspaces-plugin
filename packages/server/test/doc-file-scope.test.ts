/**
 * Which folders a doc may serve files from: those of the pages its current
 * `::html{src}` lines name, read from the live content, and none otherwise.
 */
import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { framedPages, servingFolder } from '../src/doc-file-scope.ts';

const docOf = (markdown: string): Y.Doc => {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
};

describe('framedPages', () => {
  it('names each page a directive line frames, and nothing a prose mention or a refused path names', () => {
    const ydoc = docOf(
      [
        '# Harborlight',
        '',
        '::html{src="map/index.html"}',
        '',
        'The page is `::html{src="code/x.html"}` in a sentence.',
        '',
        '::html{src="../up/index.html"}',
        '',
        '::html{src="tide.html"}',
        '',
      ].join('\n'),
    );
    expect(framedPages(ydoc)).toEqual([
      { page: ['map', 'index.html'], folder: ['map'] },
      { page: ['tide.html'], folder: [] },
    ]);
  });

  it('follows the live content: a deleted line frames nothing', () => {
    const ydoc = docOf('# Riverbend\n\n::html{src="map/index.html"}\n');
    expect(framedPages(ydoc)).toHaveLength(1);
    const frag = prose.getProseFragment(ydoc);
    frag.delete(1, 1);
    expect(framedPages(ydoc)).toEqual([]);
  });
});

describe('servingFolder', () => {
  const pages = [
    { page: ['map', 'index.html'], folder: ['map'] },
    { page: ['map', 'inner', 'index.html'], folder: ['map', 'inner'] },
  ];
  it('answers the deepest framed folder a path sits under', () => {
    expect(servingFolder(pages, ['map', 'app.js'])).toEqual(['map']);
    expect(servingFolder(pages, ['map', 'inner', 'a.js'])).toEqual(['map', 'inner']);
  });
  it('answers null outside every framed folder, for the folder itself, and with no pages', () => {
    expect(servingFolder(pages, ['config.json'])).toBeNull();
    expect(servingFolder(pages, ['mapx', 'a.js'])).toBeNull();
    expect(servingFolder(pages, ['map'])).toBeNull();
    expect(servingFolder([], ['map', 'app.js'])).toBeNull();
  });
});
