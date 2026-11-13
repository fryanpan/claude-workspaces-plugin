/**
 * The doc page's star: it reads the reader's stars, flips in place, sends
 * the flip, puts it back on a refusal, and follows a star made in another
 * tab on the board's `library.changed` frame.
 *
 * All fixtures synthetic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mountDocStar } from '../src/doc-star.ts';
import { settle } from './boot-harness.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

function harness(
  answers: { stars: string[]; post?: { ok: boolean; recorded?: boolean } },
  place: 'after' | 'before' = 'after',
) {
  document.body.innerHTML =
    '<div class="doc-crumb"><button id="doc-switcher">Plan</button></div>' +
    '<div class="cw-bar"><span>Mock</span><button data-cw-comments>Comments</button></div>';
  const refusals: string[] = [];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const listeners: Array<() => void> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      const starred = answers.stars.map((id) => ({ kind: 'doc', id, at: 1 }));
      return new Response(JSON.stringify({ starred }), { status: 200 });
    }
    const post = answers.post ?? { ok: true, recorded: true };
    return new Response(JSON.stringify({ recorded: post.recorded }), {
      status: post.ok ? 200 : 500,
    });
  }) as typeof fetch;
  const star = mountDocStar({
    workspaceId: 'w-test',
    author: ALICE,
    ...(place === 'after'
      ? { after: document.getElementById('doc-switcher') as HTMLElement }
      : { before: document.querySelector('[data-cw-comments]') as HTMLElement }),
    onRefused: (m) => refusals.push(m),
    fetch: fakeFetch,
    openStream: () => ({
      addEventListener: (_t: string, fn: unknown) => listeners.push(fn as () => void),
    }),
  });
  const btn = () => document.querySelector('.doc-star') as HTMLButtonElement;
  return { star, calls, btn, refusals, frame: () => listeners.forEach((fn) => fn()) };
}

describe('the doc page star', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sits right after the doc name and shows the reader’s star', async () => {
    const h = harness({ stars: ['d-plan'] });
    h.star.show('d-plan');
    await settle();
    expect(h.btn().previousElementSibling?.id).toBe('doc-switcher');
    expect(h.btn().getAttribute('aria-pressed')).toBe('true');
    expect(h.calls[0]?.url).toBe('/workspaces/w-test/library/stars?viewer=known-alice');
  });

  it('stars and unstars the doc in place, sending each flip', async () => {
    const h = harness({ stars: [] });
    h.star.show('d-plan');
    await settle();
    const before = h.btn();
    before.click();
    expect(h.btn()).toBe(before);
    expect(h.btn().getAttribute('aria-pressed')).toBe('true');
    await settle();
    h.btn().click();
    await settle();
    expect(h.btn().getAttribute('aria-pressed')).toBe('false');
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { kind: 'doc', id: 'd-plan', starred: true, author: ALICE },
      { kind: 'doc', id: 'd-plan', starred: false, author: ALICE },
    ]);
  });

  it('puts the star back when the server refuses it, and says so', async () => {
    const h = harness({ stars: [], post: { ok: false } });
    h.star.show('d-plan');
    await settle();
    h.btn().click();
    await settle();
    expect(h.btn().getAttribute('aria-pressed')).toBe('false');
    expect(h.refusals).toEqual(['Could not star that.']);
  });

  it('sits before a mock bar’s Comments, and hides for an item the Library does not list', async () => {
    const h = harness({ stars: ['m-sketch'] }, 'before');
    h.star.show('m-sketch');
    await settle();
    expect(h.btn().nextElementSibling?.hasAttribute('data-cw-comments')).toBe(true);
    expect(h.btn().getAttribute('aria-pressed')).toBe('true');
    expect(h.btn().hidden).toBe(false);
    h.star.show(null);
    expect(h.btn().hidden).toBe(true);
  });

  it('follows a star made in another tab on the next frame', async () => {
    const answers = { stars: [] as string[] };
    const h = harness(answers);
    h.star.show('d-plan');
    await settle();
    expect(h.btn().getAttribute('aria-pressed')).toBe('false');
    answers.stars = ['d-plan'];
    h.frame();
    await settle();
    expect(h.btn().getAttribute('aria-pressed')).toBe('true');
  });
});
