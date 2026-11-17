/**
 * The workspaces list redraws itself when a board changes elsewhere. An open
 * page hears `landing.changed` on its one stream, re-reads `/` and swaps the
 * review bar and the board list in place, keeping what the reader had open.
 * The markup is the shape `renderLanding` draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLandingLive } from '../src/landing-live.ts';

class FakeStream {
  url: string;
  closed = false;
  private handlers = new Map<string, Array<(ev: { data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, fn: (ev: { data?: string }) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  /** A frame with no body, as an older server sent it. */
  fire(name: string) {
    for (const fn of this.handlers.get(name) ?? []) fn({});
  }
  close() {
    this.closed = true;
  }
}

const review = (asks: string[], goal = 'Ship Riverbend') =>
  `<div id="landing-review"><div class="allbar goalbar"><input type="radio" name="goal-view" id="goal-view-top" class="goal-pick" checked><input type="radio" name="goal-view" id="goal-view-goals" class="goal-pick"><details class="goal-sec"><summary>${goal} <span class="count">${asks.length}</span></summary>${asks
    .map((a) => `<a class="goal-row" href="/review">${a}</a>`)
    .join('')}</details></div></div>`;
const boards = (rows: string[]) =>
  `<div id="landing-boards"><ul>${rows.map((r) => `<li class="grp"><span class="grp-name">${r}</span></li>`).join('')}</ul><details class="fold"><summary>Inactive workspaces <span class="count">1</span></summary><ul><li>Saltmarsh</li></ul></details></div>`;
const page = (asks: string[], rows: string[]) =>
  `${review(asks)}<section id="inbox">inbox</section>${boards(rows)}`;

let served: string;
let fetches: number;
let stream: FakeStream;
let stop: () => void = () => {};

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await flush();
};
const names = () =>
  [...document.querySelectorAll('#landing-boards .grp-name')].map((n) => n.textContent);
const asks = () => [...document.querySelectorAll('.goal-row')].map((n) => n.textContent);

function open(html: string) {
  document.body.innerHTML = html;
  stop = startLandingLive({
    openStream: (url) => {
      stream = new FakeStream(url);
      return stream as unknown as EventSource;
    },
    debounceMs: 0,
  });
}

beforeEach(() => {
  fetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/') return new Response('', { status: 404 });
      fetches += 1;
      return new Response(`<html><body>${served}</body></html>`);
    }),
  );
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the workspaces list stays live', () => {
  it('redraws a goal ask and a new board made elsewhere, without a reload', async () => {
    open(page(['Pick the Harborlight name'], ['Harborlight']));
    expect(stream.url).toBe('/landing/events:stream');
    served = page(
      ['Pick the Harborlight name', 'Approve the Riverbend plan'],
      ['Riverbend', 'Harborlight'],
    );
    stream.fire('landing.changed');
    await until(() => names().length === 2);
    expect(names()).toEqual(['Riverbend', 'Harborlight']);
    expect(asks()).toEqual(['Pick the Harborlight name', 'Approve the Riverbend plan']);
    // The inbox is not this module's to redraw.
    expect(document.querySelector('#inbox')?.textContent).toBe('inbox');
  });

  it('keeps the tab and the folds the reader opened', async () => {
    open(page(['Pick the Harborlight name'], ['Harborlight']));
    document.querySelector<HTMLInputElement>('#goal-view-goals')!.checked = true;
    document.querySelector<HTMLDetailsElement>('.goal-sec')!.open = true;
    document.querySelector<HTMLDetailsElement>('.fold')!.open = true;
    served = page(['Pick the Harborlight name', 'Approve the Riverbend plan'], ['Harborlight']);
    stream.fire('landing.changed');
    await until(() => asks().length === 2);
    expect(document.querySelector<HTMLInputElement>('#goal-view-goals')!.checked).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>('.goal-sec')!.open).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>('.fold')!.open).toBe(true);
  });

  it('catches up after the stream was down', async () => {
    open(page([], ['Harborlight']));
    stream.fire('open');
    await flush();
    expect(fetches).toBe(0);
    stream.fire('error');
    served = page([], ['Saltmarsh', 'Harborlight']);
    stream.fire('open');
    await until(() => names().length === 2);
    expect(names()).toEqual(['Saltmarsh', 'Harborlight']);
  });

  it('holds a swap while a finger is down, and makes it on release', async () => {
    open(page([], ['Harborlight']));
    document.dispatchEvent(new Event('pointerdown'));
    served = page([], ['Riverbend', 'Harborlight']);
    stream.fire('landing.changed');
    for (let i = 0; i < 10; i += 1) await flush();
    expect(names()).toEqual(['Harborlight']);
    document.dispatchEvent(new Event('pointerup'));
    await until(() => names().length === 2);
    expect(names()).toEqual(['Riverbend', 'Harborlight']);
  });

  it('keeps keyboard focus on the same link', async () => {
    const linked = (rows: string[]) =>
      `<div id="landing-review"></div><div id="landing-boards">${rows.map((r) => `<a class="grp-name" href="/workspaces/${r}">${r}</a>`).join('')}</div>`;
    open(linked(['Harborlight']));
    document.querySelector<HTMLAnchorElement>('a[href="/workspaces/Harborlight"]')!.focus();
    served = linked(['Riverbend', 'Harborlight']);
    stream.fire('landing.changed');
    await until(() => names().length === 2);
    expect(document.activeElement?.getAttribute('href')).toBe('/workspaces/Harborlight');
  });

  it('opens no stream on a page without the list', () => {
    document.body.innerHTML = '<p>project page</p>';
    let opened = false;
    stop = startLandingLive({
      openStream: () => {
        opened = true;
        return new FakeStream('') as unknown as EventSource;
      },
    });
    expect(opened).toBe(false);
  });
});
