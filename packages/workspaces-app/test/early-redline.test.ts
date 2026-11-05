/**
 * A live markdown diff's requests leave with the page's first ones, not after
 * its meta.
 *
 * The redline paints only once its companion doc has synced, and the
 * companion was asked for only once the doc's meta said "markdown diff", then
 * connected only once the redline's chunk and its nine imports had loaded:
 * meta, companion open, socket, sync, one after another, about 5.5 round
 * trips on a warm page and 11 on a cold one (measured on
 * staging through a 150 ms relay). A live member's address already says what
 * the page is, so the requests start from it; the meta still decides, and a
 * guess it contradicts is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MountContext } from '../src/mount-context.ts';
import { openCompanionDoc } from '../src/redline/redline-app.ts';
import {
  guessLiveMarkdownMember,
  redlineRequestsFor,
  startEarlyRedline,
  startRedlineRequests,
} from '../src/redline/redline-requests.ts';

const ID = 'harborlight-0a1b2c3-live:docs~adr~0001-testing.md';
const member = {
  docId: ID,
  workspaceId: 'harborlight-0a1b2c3-live',
  relPath: 'docs/adr/0001-testing.md',
  diffTarget: '',
};

function fakeSocket() {
  return { close: vi.fn() } as unknown as import('@claude-workspaces/core').FeedbackClient & {
    close: ReturnType<typeof vi.fn>;
  };
}

describe('the redline starts from the address', () => {
  let sent: string[] = [];
  let answer: (body: unknown) => void = () => {};

  beforeEach(() => {
    sent = [];
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        sent.push(String(url));
        return url.endsWith('/editable-file')
          ? new Promise<Response>((resolve) => {
              answer = (body) => resolve(new Response(JSON.stringify(body)));
            })
          : new Promise<Response>(() => {});
      }),
    );
  });
  afterEach(() => {
    redlineRequestsFor({ docId: 'none', workspaceId: '', relPath: '', diffTarget: '' }, () =>
      fakeSocket(),
    );
    vi.unstubAllGlobals();
  });

  it('reads a live markdown member off its id, and nothing else', () => {
    expect(guessLiveMarkdownMember(ID)).toEqual(member);
    for (const other of [
      'harborlight-0a1b2c3-9f8e7d6:docs~a.md', // pinned review: no companion
      'harborlight-0a1b2c3-live:src~app.ts', // not markdown
      'harborlight-0a1b2c3-live:edit:docs~a', // a companion itself
      'riverbend-notes', // a plain doc
    ]) {
      expect(guessLiveMarkdownMember(other)).toBeNull();
    }
  });

  it('connects the companion the moment its open answers', async () => {
    const socket = fakeSocket();
    const open = vi.fn((_url: string) => socket);
    const requests = startRedlineRequests(member, open);
    expect(open).not.toHaveBeenCalled();
    answer({ docId: 'harborlight-0a1b2c3-live:edit:docs~adr~0001-testing' });
    expect(await requests.socket).toBe(socket);
    expect(open).toHaveBeenCalledOnce();
    expect(String(open.mock.calls[0]?.[0])).toContain(
      encodeURIComponent('harborlight-0a1b2c3-live:edit:docs~adr~0001-testing'),
    );
  });

  it('sends both requests before the meta, and hands them to the mount that matches', () => {
    startEarlyRedline(ID, () => fakeSocket());
    expect(sent).toHaveLength(2);
    const before = sent.length;
    const requests = redlineRequestsFor(member, () => fakeSocket());
    expect(sent).toHaveLength(before); // nothing asked twice
    expect(requests.diff).toBeInstanceOf(Promise);
  });

  it('drops a guess the meta contradicts, and closes its socket', async () => {
    const early = fakeSocket();
    startEarlyRedline(ID, () => early);
    answer({ docId: 'harborlight-0a1b2c3-live:edit:docs~adr~0001-testing' });
    const other = { ...member, relPath: 'docs/adr/0001~testing.md' };
    redlineRequestsFor(other, () => fakeSocket());
    expect(sent).toHaveLength(4); // the mount's own two
    await vi.waitFor(() => expect(early.close).toHaveBeenCalledOnce());
  });

  it('mounts the companion on the socket that was opened early', async () => {
    const socket = fakeSocket();
    const cleanups: (() => void)[] = [];
    const ctx = {
      ...member,
      scope: { disposed: false, onCleanup: (fn: () => void) => cleanups.push(fn) },
    } as unknown as MountContext;
    const opened = { docId: 'harborlight-0a1b2c3-live:edit:docs~adr~0001-testing' };
    const companion = await openCompanionDoc(ctx, Promise.resolve(opened), Promise.resolve(socket));
    expect(companion?.client).toBe(socket);
    for (const fn of cleanups) fn();
    expect(socket.close).toHaveBeenCalled(); // and it closes with the page
  });

  it('closes the early socket when the reader left before it was used', async () => {
    const socket = fakeSocket();
    const ctx = {
      ...member,
      scope: { disposed: true, onCleanup: () => {} },
    } as unknown as MountContext;
    const companion = await openCompanionDoc(
      ctx,
      Promise.resolve({ docId: 'harborlight-0a1b2c3-live:edit:docs~adr~0001-testing' }),
      Promise.resolve(socket),
    );
    expect(companion).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
