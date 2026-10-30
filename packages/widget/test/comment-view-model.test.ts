import { describe, expect, it } from 'vitest';
import {
  type ViewRow,
  buildView,
  isNewTo,
  openCounts,
  pageKey,
  pageName,
} from '../src/comment-view-model.ts';

/**
 * What the comment view shows, decided without a page: the page each thread
 * is on, which are new to the reader, and the groups' order. Fixture names
 * only.
 */

const MOCK = '/workspaces/w-harbor/mockups/d-ferry';

describe('a thread’s page', () => {
  it('is the path and fragment, whatever the query holds', () => {
    expect(pageKey({ url: `${MOCK}?cw-frame=1#book` })).toBe(`${MOCK}#book`);
    expect(pageKey({ url: `${MOCK}?cw-frame=1&o=ss#book` })).toBe(`${MOCK}#book`);
    expect(pageKey({ url: '/pay?x=1' })).toBe('/pay');
    expect(pageKey({ url: '/pay', view: 'modal=card' })).toBe('/pay modal=card');
    expect(pageKey(undefined)).toBe('');
  });

  it('is named by the link to it, else its fragment, else its path', () => {
    expect(pageName(`${MOCK}#book`, '  Book \n a crossing ')).toBe('Book a crossing');
    expect(pageName(`${MOCK}#return-trip`)).toBe('return trip');
    expect(pageName('/harborlight/timetable/')).toBe('timetable');
    expect(pageName('/pay modal=card')).toBe('modal=card');
  });
});

describe('what is new to the reader', () => {
  const alice = { id: 'u-alice', name: 'Alice', kind: 'known' as const, color: '#000' };
  const agent = {
    id: 'a-riverbend',
    name: 'Riverbend agent',
    kind: 'known' as const,
    color: '#111',
  };
  const t = (...cs: Array<[typeof alice, number]>) => ({
    id: 't1',
    comments: cs.map(([author, ts], i) => ({ id: `c${i}`, author, ts, text: 'x' })),
  });
  const later = { first: false, since: 5000 };

  it('is a comment by someone else since the reader last opened the thread', () => {
    expect(isNewTo(t([alice, 1000], [agent, 3000]), 'u-alice', { t1: 2000 }, later)).toBe(true);
    expect(isNewTo(t([alice, 1000], [agent, 3000]), 'u-alice', { t1: 3000 }, later)).toBe(false);
  });

  it('is never the reader’s own reply', () => {
    expect(isNewTo(t([agent, 1000], [alice, 3000]), 'u-alice', { t1: 1000 }, later)).toBe(false);
    expect(isNewTo(t([alice, 1000]), 'u-alice', {}, later)).toBe(false);
  });

  it('on a first visit, is only what arrives while the reader looks', () => {
    const first = { first: true, since: 5000 };
    expect(isNewTo(t([agent, 4000]), 'u-alice', {}, first)).toBe(false);
    expect(isNewTo(t([agent, 6000]), 'u-alice', {}, first)).toBe(true);
    // CONTROL: the same thread on a later visit is new.
    expect(isNewTo(t([agent, 4000]), 'u-alice', {}, later)).toBe(true);
  });
});

describe('the groups', () => {
  const row = (id: string, key: string, last: number, more: Partial<ViewRow> = {}): ViewRow => ({
    id,
    key,
    last,
    status: 'open',
    isNew: false,
    ...more,
  });
  const rows = [
    row('t-tt', '#timetable', 1),
    row('t-book', '#book', 2),
    row('t-pay', '#pay', 3, { isNew: true }),
    row('t-pay2', '#pay', 4),
    row('t-done', '#book', 5, { status: 'resolved' }),
  ];

  it('puts new threads first, then each page in the order the page links to them', () => {
    const m = buildView(rows, {
      here: '#book',
      order: ['#timetable', '#book', '#pay'],
      kept: null,
      justResolved: null,
    });
    expect(m.fresh.map((r) => r.id)).toEqual(['t-pay']);
    expect(m.pages.map((g) => [g.key, g.here, g.rows.map((r) => r.id), g.underNew])).toEqual([
      ['#timetable', false, ['t-tt'], 0],
      ['#book', true, ['t-book'], 0],
      ['#pay', false, ['t-pay2'], 1],
    ]);
    expect(m.resolved.map((r) => r.id)).toEqual(['t-done']);
    expect([m.open, m.pageCount]).toEqual([4, 3]);
  });

  it('keeps the thread opened from New there, and a just-resolved one in its page', () => {
    const opened = rows.map((r) => (r.id === 't-pay' ? { ...r, isNew: false } : r));
    const m = buildView(opened, {
      here: '#pay',
      order: [],
      kept: 't-pay',
      justResolved: 't-done',
    });
    expect(m.fresh.map((r) => r.id)).toEqual(['t-pay']);
    expect(m.pages.find((g) => g.key === '#book')?.rows.map((r) => r.id)).toEqual([
      't-done',
      't-book',
    ]);
    expect(m.resolved).toEqual([]);
    // CONTROL: once another is opened, it goes back to its page.
    const after = buildView(opened, { here: '#pay', order: [], kept: null, justResolved: null });
    expect(after.fresh).toEqual([]);
    expect(after.pages[0]?.rows.map((r) => r.id)).toEqual(['t-pay2', 't-pay']);
  });

  it('always has a group for this page, and a lost spot only on this page', () => {
    const m = buildView([row('t-lost', '#book', 1, { status: 'orphan' })], {
      here: '#book',
      order: ['#timetable'],
      kept: null,
      justResolved: null,
    });
    expect(m.nospot.map((r) => r.id)).toEqual(['t-lost']);
    expect(m.pages.map((g) => [g.key, g.rows.length])).toEqual([['#book', 0]]);
  });

  it('counts open threads per page for the link badges', () => {
    expect([...openCounts(rows)]).toEqual([
      ['#timetable', 1],
      ['#book', 1],
      ['#pay', 2],
    ]);
  });
});
