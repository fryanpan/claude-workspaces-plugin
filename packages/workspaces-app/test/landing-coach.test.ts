/**
 * "Your coach" on the front page, driven as the owner drives it: each button
 * posts its own request and the section is re-read from `/`; "Set up my
 * coach" opens the doc the server made. The markup is the shape
 * `coach/section.ts` draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCoach } from '../src/landing-coach.ts';

const SET_UP =
  '<section id="coach"><button type="button" data-act="setup">Set up my coach</button></section>';
const READY = (pressed: string) =>
  `<section id="coach"><ol><li>Hard work first</li></ol><button type="button" data-act="add-goal">Add a goal</button><button type="button" data-review="no-update">No update needed</button>${[
    'less',
    'normal',
    'more',
  ]
    .map(
      (s) =>
        `<button type="button" data-readiness="${s}" aria-pressed="${s === pressed}">${s}</button>`,
    )
    .join('')}</section>`;

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let page: string;
let assign: ReturnType<typeof vi.fn>;
let stop: () => void = () => {};

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) await flush();
};
const click = (sel: string) => document.querySelector<HTMLElement>(sel)?.click();
const bodyOf = (url: string) => JSON.parse(String(calls.find((c) => c.url === url)?.init?.body));

function start(html: string, fresh: string) {
  document.body.innerHTML = html;
  page = fresh;
  stop = startCoach();
}

beforeEach(() => {
  calls = [];
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/') return new Response(`<html><body>${page}</body></html>`);
      if (url === '/coach/setup')
        return new Response(JSON.stringify({ url: '/workspaces/w-coach/docs/d-goals' }));
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Your coach', () => {
  it('Set up my coach makes the doc and opens it', async () => {
    start(SET_UP, SET_UP);
    click('[data-act="setup"]');
    await until(() => assign.mock.calls.length > 0);
    expect(calls.map((c) => c.url)).toEqual(['/coach/setup']);
    expect(assign).toHaveBeenCalledWith('/workspaces/w-coach/docs/d-goals');
  });

  it('How readily posts the setting and redraws the section with it pressed', async () => {
    start(READY('normal'), READY('less'));
    click('[data-readiness="less"]');
    await until(() => calls.some((c) => c.url === '/'));
    await until(
      () =>
        document.querySelector('[data-readiness="less"]')?.getAttribute('aria-pressed') === 'true',
    );
    expect(bodyOf('/coach/prefs')).toEqual({ readiness: 'less' });
  });

  it('Add a goal and No update needed each post their own request', async () => {
    start(READY('normal'), READY('normal'));
    click('[data-act="add-goal"]');
    await until(() => calls.some((c) => c.url === '/'));
    click('[data-review="no-update"]');
    await until(() => calls.filter((c) => c.url === '/').length === 2);
    expect(calls.map((c) => c.url)).toEqual(['/coach/goals/add', '/', '/coach/review', '/']);
    expect(bodyOf('/coach/review')).toEqual({ answer: 'no-update' });
  });
});
