/**
 * The parts of an open workspaces list that keep their own stores: Incoming
 * Messages and the meeting banner. A `landing.changed`
 * frame names the parts that changed, and the page redraws those and only
 * those, without a reload. The markup is the shape the server draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startInbox } from '../src/landing-inbox.ts';
import { startLandingLive } from '../src/landing-live.ts';

class FakeStream {
  url: string;
  private handlers = new Map<string, Array<(ev: { data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, fn: (ev: { data?: string }) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  /** One frame, as the server sends it. */
  changed(...parts: string[]) {
    const data = JSON.stringify({ event: 'landing.changed', parts });
    for (const fn of this.handlers.get('landing.changed') ?? []) fn({ data });
  }
  close() {}
}

const LINE = (id: string, purpose: string) =>
  `<div class="inbox-row" data-row="${id}" data-channel="Email"><div class="inbox-line"><button type="button" class="board-review-row" aria-expanded="false"><span class="board-review-row-title">${purpose}</span></button></div></div>`;
const inbox = (lines: Array<[string, string]>) =>
  `<section id="inbox" class="inbox-front" tabindex="-1"><div class="inbox-rows">${lines.map(([id, p]) => LINE(id, p)).join('')}</div></section>`;
const boards = (name: string) =>
  `<div id="landing-boards"><span class="grp-name">${name}</span></div>`;
const page = (i: string, b: string) =>
  `<meeting-banner></meeting-banner><div id="landing-review"></div>${i}${b}`;

const A: [string, string] = ['ib-aaaaaaaaaaaa', 'Wants a yes on the Saltmarsh dates'];
const B: [string, string] = ['ib-bbbbbbbbbbbb', 'Asks about the Riverbend rota'];

let served: string;
let bodyReads: number;
let stream: FakeStream;
let stop: () => void = () => {};
let bannerReads: number;

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await flush();
  expect(ok()).toBe(true);
};
const titles = () =>
  [...document.querySelectorAll('#inbox .board-review-row-title')].map((n) => n.textContent);

function open(html: string) {
  document.body.innerHTML = html;
  const banner = document.querySelector('meeting-banner') as unknown as { refresh: () => void };
  banner.refresh = () => {
    bannerReads += 1;
  };
  startInbox();
  stop = startLandingLive({
    openStream: (url) => {
      stream = new FakeStream(url);
      return stream as unknown as EventSource;
    },
    debounceMs: 0,
  });
}

beforeEach(() => {
  bodyReads = 0;
  bannerReads = 0;
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/body')) {
        bodyReads += 1;
        return new Response(JSON.stringify({ body: 'Hold the 14th?', reply: { kind: 'none' } }));
      }
      if (url === '/') return new Response(`<html><body>${served}</body></html>`);
      return new Response('', { status: 404 });
    }),
  );
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the parts of the list with their own stores stay live', () => {
  it('adds a message posted elsewhere, keeping the open line and its text', async () => {
    open(page(inbox([A]), boards('Harborlight')));
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(() => document.querySelector('.inbox-msg')?.textContent === 'Hold the 14th?');
    served = page(inbox([B, A]), boards('Harborlight'));
    stream.changed('inbox');
    await until(() => titles().length === 2);
    expect(titles()).toEqual([B[1], A[1]]);
    const openRow = document.querySelector('.inbox-row-open');
    expect(openRow?.getAttribute('data-row')).toBe(A[0]);
    expect(openRow?.querySelector('.inbox-msg')?.textContent).toBe('Hold the 14th?');
    expect(bodyReads).toBe(1);
  });

  it('holds the inbox while the reader types, and redraws once they stop', async () => {
    open(page(inbox([A]), boards('Harborlight')));
    const box = document.createElement('textarea');
    document.querySelector('#inbox .inbox-row')?.append(box);
    box.focus();
    served = page(inbox([B, A]), boards('Harborlight'));
    stream.changed('inbox');
    for (let i = 0; i < 10; i += 1) await flush();
    expect(titles()).toEqual([A[1]]);
    box.blur();
    await until(() => titles().length === 2);
  });

  it('asks the meeting banner to re-read when a meeting starts or ends', async () => {
    open(page(inbox([A]), boards('Harborlight')));
    stream.changed('meeting');
    await until(() => bannerReads === 1);
  });
});
