import { describe, expect, it } from 'bun:test';
import {
  BOARD_BLOCK_COLOURS,
  blockRun,
  renderReviewBar,
  reviewHrefFor,
  waitingGroups,
} from '../src/landing-review.ts';

/**
 * Home's review bar, rendered: one group per project in queue order, each a
 * count and a run of blocks where five items fold into one shiny block, and
 * each group a link into the queue at that project's first item. Board names
 * are invented.
 */

const item = (workspaceId: string, project: string) => ({ workspaceId, project });

function bar(items: Array<{ workspaceId: string; project: string }>) {
  return renderReviewBar({ items, rankOf: new Map(), summaryOf: () => undefined });
}

/** Each rendered group: where it goes, its label, and its blocks. */
function groups(html: string) {
  return [
    ...html.matchAll(
      /<a class="qgrp" href="([^"]+)"[^>]*aria-label="([^"]*)"><span class="qname">[^<]*<span class="qn">(\d+)<\/span><\/span><span class="qrun" aria-hidden="true">((?:<span class="qb[^"]*"><\/span>)*)<\/span><\/a>/g,
    ),
  ].map((m) => ({
    href: m[1],
    label: m[2],
    count: Number(m[3]),
    shiny: (m[4]?.match(/class="qb qb5"/g) ?? []).length,
    plain: (m[4]?.match(/class="qb"/g) ?? []).length,
  }));
}

describe('the five-fold', () => {
  it('folds every five items into one shiny block and keeps the rest plain', () => {
    expect([0, 1, 4, 5, 12].map(blockRun)).toEqual([
      { shiny: 0, plain: 0 },
      { shiny: 0, plain: 1 },
      { shiny: 0, plain: 4 },
      { shiny: 1, plain: 0 },
      { shiny: 2, plain: 2 },
    ]);
  });

  it('draws those blocks for a group of each size', () => {
    for (const [n, shiny, plain] of [
      [1, 0, 1],
      [4, 0, 4],
      [5, 1, 0],
      [12, 2, 2],
    ] as const) {
      const html = bar(Array.from({ length: n }, () => item('w-kiln', 'Kiln')));
      expect(groups(html)).toEqual([
        { href: '/review?from=w-kiln', label: 'Kiln, ' + n + ' waiting', count: n, shiny, plain },
      ]);
    }
  });
});

describe('the bar', () => {
  it('is absent when nothing waits', () => {
    expect(bar([])).toBe('');
  });

  it('keeps queue order, one group per project, counted', () => {
    const html = bar([
      item('w-harbor', 'Harborlight'),
      item('w-harbor', 'Harborlight'),
      item('w-river', 'Riverbend'),
      item('w-salt', 'Saltmarsh'),
      item('w-river', 'Riverbend'),
    ]);
    expect(groups(html).map((g) => [g.label, g.count])).toEqual([
      ['Harborlight, 2 waiting', 2],
      ['Riverbend, 2 waiting', 2],
      ['Saltmarsh, 1 waiting', 1],
    ]);
    expect(waitingGroups([item('b', 'B'), item('a', 'A'), item('b', 'B')])).toEqual([
      { workspaceId: 'b', project: 'B', count: 2 },
      { workspaceId: 'a', project: 'A', count: 1 },
    ]);
  });

  it('sends a group to its project in the queue, and Start review to the top', () => {
    const html = bar([item('w-river', 'Riverbend'), item('w a&b', 'Kiln')]);
    expect(groups(html).map((g) => g.href)).toEqual([
      '/review?from=w-river',
      `/review?from=${encodeURIComponent('w a&b').replace(/&/g, '&amp;')}`,
    ]);
    expect(reviewHrefFor('w a&b')).toBe('/review?from=w%20a%26b');
    expect(html).toContain('<a class="allgo" href="/review">Start review ›</a>');
  });

  it('gives a board the same colour on every render and escapes its name', () => {
    const colourOf = (html: string) => html.match(/style="--c:(#[0-9a-f]{6})"/)?.[1];
    const first = colourOf(bar([item('w-river', 'Riverbend')]));
    expect(BOARD_BLOCK_COLOURS).toContain(first ?? '');
    expect(colourOf(bar([item('w-river', 'Riverbend'), item('w-kiln', 'Kiln')]))).toBe(first);
    const html = bar([item('w-x', '<b>Kiln</b>')]);
    expect(html).not.toContain('<b>Kiln</b>');
    expect(html).toContain('&lt;b&gt;Kiln&lt;/b&gt;, 1 waiting');
  });

  it('says no minutes anywhere', () => {
    const html = bar(Array.from({ length: 12 }, () => item('w-kiln', 'Kiln')));
    expect(html).not.toMatch(/\bmin\b|minute|estimat/i);
  });
});
