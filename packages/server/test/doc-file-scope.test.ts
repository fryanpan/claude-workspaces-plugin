/**
 * Which folders a doc may serve files from: the subfolder of a present,
 * git-listed page that one of its current `::html{src}` lines names, and none
 * otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { candidatePages, framedPages, servingFolder } from '../src/doc-file-scope.ts';

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

  it('reads a line inside a list or a quote, as the editor renders it', () => {
    const ydoc = docOf(
      '# Saltmarsh\n\n- ::html{src="list/index.html"}\n\n> ::html{src="quote/index.html"}\n',
    );
    expect(framedPages(ydoc).map((p) => p.folder)).toEqual([['list'], ['quote']]);
  });

  it('follows the live content: a deleted line frames nothing', () => {
    const ydoc = docOf('# Riverbend\n\n::html{src="map/index.html"}\n');
    expect(framedPages(ydoc)).toHaveLength(1);
    prose.getProseFragment(ydoc).delete(1, 1);
    expect(framedPages(ydoc)).toEqual([]);
  });
});

describe('candidatePages', () => {
  const pages = [
    { page: ['map', 'index.html'], folder: ['map'] },
    { page: ['map', 'inner', 'index.html'], folder: ['map', 'inner'] },
    { page: ['index.html'], folder: [] },
  ];
  it('orders the pages a path sits under deepest first, and never a page at the doc level', () => {
    expect(candidatePages(pages, ['map', 'inner', 'a.js']).map((p) => p.folder)).toEqual([
      ['map', 'inner'],
      ['map'],
    ]);
    expect(candidatePages(pages, ['map', 'app.js']).map((p) => p.folder)).toEqual([['map']]);
    expect(candidatePages(pages, ['config.json'])).toEqual([]);
    expect(candidatePages(pages, ['mapx', 'a.js'])).toEqual([]);
    expect(candidatePages(pages, ['map'])).toEqual([]);
  });
});

describe('servingFolder', () => {
  let root: string;
  let repo: string;
  let loose: string;
  const write = (abs: string, text = 'x') => {
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-file-scope-'));
    repo = join(root, 'repo');
    loose = join(root, 'loose');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    for (const base of [repo, loose]) {
      write(join(base, 'map', 'index.html'));
      write(join(base, 'map', 'app.js'));
      write(join(base, 'index.html'));
      write(join(base, 'config.json'));
      write(join(base, 'ghost', 'data.json'));
    }
    write(join(repo, '.gitignore'), 'hidden/\n');
    write(join(repo, 'hidden', 'index.html'));
    write(join(repo, 'hidden', 'data.json'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const page = (src: string) => framedPages(docOf(`# Harborlight\n\n::html{src="${src}"}\n`));

  it('serves the folder of a present, listed page in a repository', async () => {
    expect(await servingFolder(repo, page('map/index.html'), ['map', 'app.js'])).toEqual(['map']);
  });

  it('serves nothing for a page at the doc level', async () => {
    expect(await servingFolder(repo, page('index.html'), ['config.json'])).toBeNull();
    expect(await servingFolder(repo, page('index.html'), ['map', 'app.js'])).toBeNull();
  });

  it('serves nothing for a line naming a page that is not there, or not listed', async () => {
    expect(await servingFolder(repo, page('ghost/index.html'), ['ghost', 'data.json'])).toBeNull();
    expect(
      await servingFolder(repo, page('hidden/index.html'), ['hidden', 'data.json']),
    ).toBeNull();
  });

  it('serves nothing for a doc folder outside a git work tree', async () => {
    expect(await servingFolder(loose, page('map/index.html'), ['map', 'app.js'])).toBeNull();
  });
});
