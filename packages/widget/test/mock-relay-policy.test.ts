/**
 * The host page's whole decision about a mock frame's board call.
 *
 * Every allowed shape is paired with the nearest shape that must be refused:
 * another doc, another board, another ticket item, a dot segment that walks
 * out, another host, a verb that is not on the list. The widget's own calls
 * are the allowed half, so a regression that refuses one of them breaks the
 * widget inside a mock, and one that allows a neighbour lets a mock's script
 * write where it was never granted.
 *
 * Fixtures are fictional — a lemonade stand's price board.
 */
import { describe, expect, it } from 'vitest';
import { type RelayScope, relayHeaders, relayTarget } from '../src/mock-relay-policy.ts';

const SCOPE: RelayScope = {
  host: 'board.test',
  workspaceId: 'w-stand',
  docId: 'd-price',
  items: [['t-price', 'r-board']],
};
const DOC = 'http://board.test/workspaces/w-stand/docs/d-price';
const ok = (kind: 'fetch' | 'ws' | 'sse', method: string, url: string) =>
  relayTarget(SCOPE, kind, method, url) !== null;

describe('what a frame may fetch through the host', () => {
  it("allows the widget's reads, and no read off another doc or board", () => {
    expect(ok('fetch', 'GET', 'http://board.test/api/auth/session')).toBe(true);
    expect(ok('fetch', 'GET', `${DOC}/threads`)).toBe(true);
    expect(ok('fetch', 'HEAD', `${DOC}/threads`)).toBe(true);
    expect(
      ok('fetch', 'GET', 'http://board.test/workspaces/w-stand/mockups/d-price?v=2&cw-frame=1'),
    ).toBe(true);
    expect(ok('fetch', 'GET', 'http://board.test/widget/voice.js')).toBe(true);

    expect(ok('fetch', 'GET', 'http://board.test/workspaces/w-stand/docs/d-menu/threads')).toBe(
      false,
    );
    expect(ok('fetch', 'GET', 'http://board.test/workspaces/w-other/docs/d-price/threads')).toBe(
      false,
    );
    expect(ok('fetch', 'GET', 'http://board.test/workspaces/w-stand/mockups/d-menu')).toBe(false);
    expect(ok('fetch', 'GET', 'http://board.test/workspaces/w-stand/tasks?format=json')).toBe(
      false,
    );
    expect(ok('fetch', 'GET', 'http://board.test/api/auth/widget-session')).toBe(false);
    // The doc's own prefix, but not under it.
    expect(ok('fetch', 'GET', DOC)).toBe(false);
    expect(ok('fetch', 'GET', `${DOC}-copy/threads`)).toBe(false);
  });

  it('allows posting on this doc’s threads, and nothing else on it or anywhere', () => {
    expect(ok('fetch', 'POST', `${DOC}/threads`)).toBe(true);
    // `edit-comment` and `reanchor` are voice feedback's; the server lets a
    // relayed one reach only what was written from inside the mock.
    for (const verb of ['comments', 'answer', 'resolve', 'reopen', 'edit-comment', 'reanchor']) {
      expect(ok('fetch', 'POST', `${DOC}/threads/th-1/${verb}`)).toBe(true);
      expect(ok('fetch', 'post', `${DOC}/threads/th-1/${verb}`)).toBe(true);
    }
    expect(ok('fetch', 'POST', `${DOC}/threads/th-1/comments/c-1/edit`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/threads//comments`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/threads/th-1/delete`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/threads/th-1/revise`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/threads/th-1/rewrite_region`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/threads/th-1`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/content`)).toBe(false);
    expect(ok('fetch', 'PUT', `${DOC}/threads`)).toBe(false);
    expect(ok('fetch', 'DELETE', `${DOC}/threads/th-1`)).toBe(false);
    expect(ok('fetch', 'POST', 'http://board.test/workspaces/w-stand/docs/d-menu/threads')).toBe(
      false,
    );
    expect(ok('fetch', 'POST', 'http://board.test/workspaces/w-stand/tasks')).toBe(false);
    expect(ok('fetch', 'POST', 'http://board.test/api/deploy')).toBe(false);
  });

  it('allows answering only the ticket items the server docked on this mock', () => {
    const item = (t: string, r: string) =>
      `http://board.test/workspaces/w-stand/tasks/${t}/review-items/${r}/answer`;
    expect(ok('fetch', 'POST', item('t-price', 'r-board'))).toBe(true);
    expect(ok('fetch', 'POST', item('t-price', 'r-other'))).toBe(false);
    expect(ok('fetch', 'POST', item('t-other', 'r-board'))).toBe(false);
    expect(ok('fetch', 'POST', `${item('t-price', 'r-board')}/undo`)).toBe(false);
    expect(ok('fetch', 'POST', item('t-price', 'r-board').replace('w-stand', 'w-other'))).toBe(
      false,
    );
  });

  it('judges the path the URL really names, on this host only', () => {
    // A dot segment, plain or encoded, is resolved before the list is read.
    expect(ok('fetch', 'POST', `${DOC}/../d-menu/threads`)).toBe(false);
    expect(ok('fetch', 'POST', `${DOC}/%2e%2e/d-menu/threads`)).toBe(false);
    expect(ok('fetch', 'GET', `${DOC}/../../../../api/deploy`)).toBe(false);
    // A relative address is this board.
    expect(ok('fetch', 'POST', '/workspaces/w-stand/docs/d-price/threads')).toBe(true);
    expect(
      ok('fetch', 'POST', 'http://elsewhere.test/workspaces/w-stand/docs/d-price/threads'),
    ).toBe(false);
    expect(
      ok('fetch', 'POST', 'http://user:pw@board.test/workspaces/w-stand/docs/d-price/threads'),
    ).toBe(false);
    expect(ok('fetch', 'GET', 'not a url at all ::')).toBe(false);
  });
});

describe('what a frame may open through the host', () => {
  it("allows this doc's live and voice sockets, marked, with no source of the frame's choosing", () => {
    const y = relayTarget(SCOPE, 'ws', 'GET', `${DOC}/y?type=mockup&sourceUrl=http://evil.test/`);
    expect(y?.pathname).toBe('/workspaces/w-stand/docs/d-price/y');
    expect(y?.searchParams.get('sourceUrl')).toBeNull();
    expect(y?.searchParams.get('type')).toBe('mockup');
    expect(y?.searchParams.getAll('cw-via')).toEqual(['mock-frame']);
    // A frame that sends its own mark gets exactly one, the host's.
    const doubled = relayTarget(SCOPE, 'ws', 'GET', `${DOC}/voice?cw-via=other`);
    expect(doubled?.searchParams.getAll('cw-via')).toEqual(['mock-frame']);

    expect(ok('ws', 'GET', 'http://board.test/workspaces/w-stand/docs/d-menu/y')).toBe(false);
    expect(ok('ws', 'GET', 'http://board.test/workspaces/w-stand/y')).toBe(false);
    expect(ok('ws', 'GET', `${DOC}/audio`)).toBe(false);
  });

  it("allows this doc's event stream and no other", () => {
    expect(ok('sse', 'GET', `${DOC}/events:stream`)).toBe(true);
    expect(ok('sse', 'GET', 'http://board.test/workspaces/w-stand/events:stream')).toBe(false);
    expect(ok('sse', 'GET', 'http://board.test/workspaces/w-stand/docs/d-menu/events:stream')).toBe(
      false,
    );
  });
});

describe('the headers a relayed fetch carries', () => {
  it('keeps content-type and accept, drops everything else, and adds the mark', () => {
    expect(
      relayHeaders([
        ['Content-Type', 'application/json'],
        ['accept', 'application/json'],
        ['authorization', 'Bearer abc'],
        ['x-cw-via', 'board'],
        ['cookie', 'x=1'],
        ['x-forwarded-for', '1.2.3.4'],
      ]),
    ).toEqual([
      ['Content-Type', 'application/json'],
      ['accept', 'application/json'],
      ['x-cw-via', 'mock-frame'],
    ]);
  });
});
