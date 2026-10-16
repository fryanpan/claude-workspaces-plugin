/**
 * The home feed's schema check and Home's text-only drawing of it, driven
 * directly. The two-server proof is `home-across-servers.test.ts`; these
 * pin the edges one row at a time.
 */
import { describe, expect, it } from 'bun:test';
import type { CrossReviewItem } from '../src/cross-review-queue.ts';
import { MAX_FEED_ROWS, boardHref, homeFeedOf, readHomeFeed } from '../src/home-feed.ts';
import { renderRemoteReview } from '../src/landing-remote.ts';

const BOARD = 'w-riverbend';
const HELD = new Set([BOARD, 'w-river2']);
const SINCE = Date.UTC(2026, 9, 16);
const row = (over: Record<string, unknown> = {}) => ({
  key: 'k-1',
  kind: 'task-review',
  title: 'Riverbend notes',
  ask: 'Friday or Monday?',
  askedBy: 'Riverbend lead',
  since: SINCE,
  ...over,
});
const feed = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  v: 1,
  boardId: BOARD,
  boardName: 'Riverbend board',
  rows,
  ...over,
});

describe('boardHref', () => {
  it('keeps a path on a board the server holds', () => {
    expect(boardHref(`/workspaces/${BOARD}?task=t-1`, HELD)).toBe(`/workspaces/${BOARD}?task=t-1`);
    expect(boardHref('/workspaces/w-river2/docs/d-1?thread=th-1', HELD)).toBe(
      '/workspaces/w-river2/docs/d-1?thread=th-1',
    );
  });

  it.each([
    ['a script URL', 'javascript:alert(1)'],
    ['another scheme', 'data:text/html,<script>x</script>'],
    ['an absolute URL', `https://harborlight.test/workspaces/${BOARD}`],
    ['a protocol-relative host', `//harborlight.test/workspaces/${BOARD}`],
    ['a board another server holds', '/workspaces/w-saltmarsh?task=t-1'],
    ['a path off every board', '/api/review-queue'],
    ['a dot segment out of the board', `/workspaces/${BOARD}/../w-saltmarsh`],
    ['a backslash', `/workspaces/${BOARD}\\..\\w-saltmarsh`],
    ['whitespace', `/workspaces/${BOARD} onmouseover=x`],
    ['a prefix of a held board id', '/workspaces/w-river'],
    ['a non-string', 42],
  ])('drops %s', (_why, href) => {
    expect(boardHref(href, HELD)).toBeUndefined();
  });
});

describe('readHomeFeed', () => {
  it('rebuilds each row from its named fields only', () => {
    const read = readHomeFeed(
      feed([row({ href: `/workspaces/${BOARD}?task=t-1`, onclick: 'x', html: '<b>' })], {
        extra: 'dropped',
      }),
      BOARD,
      HELD,
    );
    expect(read).toEqual({
      boardName: 'Riverbend board',
      rows: [
        {
          key: 'k-1',
          kind: 'task-review',
          title: 'Riverbend notes',
          ask: 'Friday or Monday?',
          askedBy: 'Riverbend lead',
          since: SINCE,
          href: `/workspaces/${BOARD}?task=t-1`,
        },
      ],
      dropped: 0,
      linksRefused: 0,
    });
  });

  it('drops and counts a row with a bad required field, and keeps a row whose link it removed', () => {
    const read = readHomeFeed(
      feed([
        row({ key: 'bad-kind', kind: 'html' }),
        row({ key: 'bad-since', since: 'yesterday' }),
        row({ key: 'bad-title', title: 7 }),
        row({ key: 'bidi', title: 'Riverbend ‮notes' }),
        row({ key: 'nul', ask: 'a\u0000b' }),
        row({ key: 'k-1', href: 'javascript:alert(1)' }),
        row({ key: 'k-1' }),
        'not a row',
      ]),
      BOARD,
      HELD,
    );
    expect(read?.rows.map((r) => r.key)).toEqual(['k-1']);
    expect(read?.rows[0]?.href).toBeUndefined();
    expect(read?.dropped).toBe(7);
    expect(read?.linksRefused).toBe(1);
  });

  it('keeps newlines in text and an empty ask', () => {
    const read = readHomeFeed(feed([row({ ask: '', title: 'Two\r\nlines' })]), BOARD, HELD);
    expect(read?.rows[0]).toMatchObject({ ask: '', title: 'Two\r\nlines' });
  });

  it('refuses rows past the cap', () => {
    const rows = Array.from({ length: MAX_FEED_ROWS + 3 }, (_, i) => row({ key: `k-${i}` }));
    const read = readHomeFeed(feed(rows), BOARD, HELD);
    expect(read?.rows).toHaveLength(MAX_FEED_ROWS);
    expect(read?.dropped).toBe(3);
  });

  it('is not a feed when the version, the board or the shape is wrong', () => {
    expect(readHomeFeed(feed([], { v: 2 }), BOARD, HELD)).toBeNull();
    expect(readHomeFeed(feed([], { boardId: 'w-saltmarsh' }), BOARD, HELD)).toBeNull();
    expect(readHomeFeed(feed([], { rows: {} }), BOARD, HELD)).toBeNull();
    expect(readHomeFeed([], BOARD, HELD)).toBeNull();
    expect(readHomeFeed('{}', BOARD, HELD)).toBeNull();
  });

  it('names the board by id when the name fails the check', () => {
    expect(readHomeFeed(feed([], { boardName: 5 }), BOARD, HELD)?.boardName).toBe(BOARD);
  });
});

describe('homeFeedOf', () => {
  const item = (over: Partial<CrossReviewItem>): CrossReviewItem =>
    ({
      kind: 'task-review',
      band: 'declared',
      taskId: 't-1',
      reviewItemId: 'ri-1',
      title: 'Riverbend notes',
      ask: 'Friday?',
      askedBy: 'Riverbend lead',
      since: SINCE,
      workspaceId: BOARD,
      project: 'Riverbend board',
      key: `${BOARD}:t-1`,
      minutes: 1,
      size: 'easy',
      ...over,
    }) as CrossReviewItem;

  it('keeps one board’s items and links each where its board opens it', () => {
    const out = homeFeedOf(BOARD, 'Riverbend board', [
      item({}),
      item({ workspaceId: 'w-saltmarsh', key: 'w-saltmarsh:t-9' }),
      item({
        kind: 'doc-thread',
        docId: 'd-1',
        docType: 'mockup',
        threadId: 'th-1',
        key: `${BOARD}:d-1`,
      } as Partial<CrossReviewItem>),
    ]);
    expect(out.rows.map((r) => r.href)).toEqual([
      `/workspaces/${BOARD}?task=t-1`,
      `/workspaces/${BOARD}/mockups/d-1?thread=th-1`,
    ]);
    // What one end writes, the other end reads back whole.
    expect(readHomeFeed(JSON.parse(JSON.stringify(out)), BOARD, HELD)?.rows).toEqual(out.rows);
  });
});

describe('renderRemoteReview', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    boardId: BOARD,
    boardName: 'Riverbend <i>board</i>',
    rows: [
      {
        key: 'k-1',
        kind: 'task-review' as const,
        title: '<script>x</script>',
        ask: '[a](javascript:y)',
        askedBy: '"lead"',
        since: SINCE,
        href: `/workspaces/${BOARD}?task=t-1&x="y"`,
      },
    ],
    dropped: 0,
    linksRefused: 0,
    reached: true,
    ...over,
  });

  it('escapes every field and the link', () => {
    const html = renderRemoteReview([view()], SINCE);
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('[a](javascript:y)');
    expect(html).toContain('&quot;lead&quot;');
    expect(html).toContain('Riverbend &lt;i&gt;board&lt;/i&gt;');
    expect(html).toContain(`href="/workspaces/${BOARD}?task=t-1&amp;x=&quot;y&quot;"`);
    expect(html).not.toMatch(/<(script|i)>/);
  });

  it('draws a row with no link as text', () => {
    const v = view();
    const html = renderRemoteReview([{ ...v, rows: [{ ...v.rows[0], href: undefined }] }], SINCE);
    expect(html).not.toContain('href=');
  });

  it('says when a board was not reached, and draws nothing when nothing waits', () => {
    expect(renderRemoteReview([view({ rows: [], reached: false })], SINCE)).toContain(
      'Not reached.',
    );
    expect(renderRemoteReview([view({ reached: false })], SINCE)).toContain(
      'Not reached; these are the last items read.',
    );
    expect(renderRemoteReview([view({ rows: [] })], SINCE)).toBe('');
    expect(renderRemoteReview([], SINCE)).toBe('');
  });
});
