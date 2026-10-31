/**
 * Incoming Messages on the front page, driven as Bryan drives it: a tap
 * opens a line and shows its text as text, `b` opens the snooze modal, a
 * choice posts the snooze. The markup is the shape `inbox/section.ts` draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_SECTION_CSS } from '../../server/src/inbox/section-css.ts';
import { snoozeChoices, startInbox } from '../src/landing-inbox.ts';

const LINE = (id: string, purpose: string) =>
  `<div class="inbox-row" data-row="${id}" data-channel="Email"><div class="inbox-line"><div class="inbox-swipe-under"></div><button type="button" class="board-review-row" aria-expanded="false"><span class="board-review-row-title">${purpose}</span></button><div class="inbox-line-acts"><button type="button" class="inbox-snooze-btn" data-act="snooze" aria-label="Snooze"></button></div></div></div>`;

const REMOVED = `<button type="button" class="inbox-fold-line" data-fold="removed" aria-expanded="false">Show 1 removed</button><div class="inbox-fold" data-fold-body="removed" hidden><div class="inbox-row inbox-row-folded" data-row="ib-cccccccccccc"><div class="board-review-row"><span class="board-review-row-title">Sends the Harborlight survey</span><button type="button" class="inbox-undo" data-act="reopen">Bring back</button></div></div></div>`;

const SECTION = `<section id="inbox" class="inbox-front" tabindex="-1"><div class="inbox-rows">${LINE('ib-aaaaaaaaaaaa', 'Wants a yes on the Saltmarsh dates')}${LINE('ib-bbbbbbbbbbbb', 'Asks about Thursday')}</div>${REMOVED}<div class="inbox-foot"><span class="inbox-count">2 open</span></div></section>`;

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let bodyReply: unknown;

beforeEach(() => {
  document.body.innerHTML = SECTION;
  calls = [];
  bodyReply = { body: 'Hold the 14th? <img src=x onerror="window.hit=1">', link: null };
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/body')) return new Response(JSON.stringify(bodyReply));
      if (url === '/') return new Response(`<html><body>${SECTION}</body></html>`);
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  startInbox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(check()).toBe(true);
};

describe('a tap', () => {
  it('opens the line and shows its message as text, never as markup', async () => {
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(
      () => document.querySelector('.inbox-msg')?.textContent?.startsWith('Hold') ?? false,
    );
    expect(calls[0]?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/body');
    expect(document.querySelector('.inbox-msg')?.textContent).toContain('<img src=x');
    expect(document.querySelector('.inbox-card img')).toBeNull();
    expect(document.querySelector('.inbox-row')?.classList.contains('inbox-row-open')).toBe(true);
  });

  it('shows the thread link only when it is one of the allowed schemes', async () => {
    bodyReply = { body: 'Hi', link: 'javascript:alert(1)' };
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(() => document.querySelector('.inbox-msg')?.textContent === 'Hi');
    expect(document.querySelector('.inbox-card a')).toBeNull();

    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    bodyReply = { body: 'Hi', link: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c30001' };
    document.querySelector<HTMLButtonElement>('.inbox-line > .board-review-row')?.click();
    await until(() => document.querySelector('.inbox-card a') !== null);
    const a = document.querySelector<HTMLAnchorElement>('.inbox-card a');
    expect(a?.textContent).toBe('Open in Email');
    expect(a?.rel).toBe('noopener noreferrer');
  });
});

describe('the cursor', () => {
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  const cursorRow = () =>
    document.querySelector<HTMLElement>('.inbox-rows > .inbox-row-cursor')?.dataset.row ?? null;
  const bar = (row: string) => {
    const b = document.querySelector(`[data-row="${row}"] .inbox-line > .board-review-row`);
    return b ? getComputedStyle(b).boxShadow : null;
  };

  it('is on no line until a key, then j lands on the first line and j again on the second', () => {
    expect(cursorRow()).toBeNull();
    key('j');
    expect(cursorRow()).toBe('ib-aaaaaaaaaaaa');
    key('j');
    expect(cursorRow()).toBe('ib-bbbbbbbbbbbb');
    key('k');
    expect(cursorRow()).toBe('ib-aaaaaaaaaaaa');
  });

  it('draws a bar on the line the reader sees, and none on the others', () => {
    // The section's own stylesheet, as the front page inlines it.
    const style = document.createElement('style');
    style.textContent = INBOX_SECTION_CSS;
    document.head.append(style);
    try {
      expect(bar('ib-aaaaaaaaaaaa')).not.toContain('inset');
      key('j');
      expect(bar('ib-aaaaaaaaaaaa')).toContain('inset');
      expect(bar('ib-bbbbbbbbbbbb')).not.toContain('inset');
    } finally {
      style.remove();
    }
  });
});

describe('snooze', () => {
  it('`b` opens the modal on the cursor line, and a choice posts the snooze', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    const modal = document.querySelector('.inbox-modal');
    expect(modal?.textContent).toContain('Snooze until…');
    const before = Date.now();
    modal?.querySelector<HTMLButtonElement>('.inbox-modal-opt')?.click();
    await until(() => calls.some((c) => c.url.endsWith('/state')));
    const post = calls.find((c) => c.url.endsWith('/state'));
    expect(post?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/state');
    const sent = JSON.parse(String(post?.init?.body)) as { action: string; until: number };
    expect(sent.action).toBe('snooze');
    expect(sent.until).toBeGreaterThan(before);
    await until(() => document.querySelector('.inbox-toast') !== null);
    expect(document.querySelector('.inbox-modal')).toBeNull();
  });

  it('the hover clock opens the same modal', () => {
    document.querySelectorAll<HTMLButtonElement>('.inbox-snooze-btn')[1]?.click();
    expect(document.querySelector('.inbox-modal')?.getAttribute('aria-label')).toBe('Snooze until');
  });

  it('j moves the cursor and Escape closes the modal', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    const rows = document.querySelectorAll('.inbox-row');
    expect(rows[0]?.classList.contains('inbox-row-cursor')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.inbox-modal')).toBeNull();
  });
});

const posted = (action: string) =>
  calls
    .filter((c) => c.url.endsWith('/state'))
    .map((c) => ({ url: c.url, ...(JSON.parse(String(c.init?.body)) as { action: string }) }))
    .filter((b) => b.action === action);
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));

describe('remove', () => {
  it('`e` removes the cursor line, and the toast’s Undo brings it back', async () => {
    key('e');
    await until(() => posted('remove').length === 1);
    expect(posted('remove')[0]?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/state');
    await until(
      () => document.querySelector('.inbox-toast')?.textContent?.includes('Removed') ?? false,
    );
    document.querySelector<HTMLButtonElement>('.inbox-toast button')?.click();
    await until(() => posted('undo').length === 1);
    expect(posted('undo')[0]?.url).toBe('/inbox/rows/ib-aaaaaaaaaaaa/state');
  });

  it('an opened line has a Remove button beside the reply', async () => {
    bodyReply = { body: 'Hi', link: null, reply: { kind: 'send' } };
    document.querySelectorAll<HTMLButtonElement>('.inbox-line > .board-review-row')[1]?.click();
    await until(() => document.querySelector('.inbox-card [data-act="remove"]') !== null);
    const acts = document.querySelector('.inbox-card .inbox-actions');
    expect(acts?.textContent).toContain('Send');
    acts?.querySelector<HTMLButtonElement>('[data-act="remove"]')?.click();
    await until(() => posted('remove').length === 1);
    expect(posted('remove')[0]?.url).toBe('/inbox/rows/ib-bbbbbbbbbbbb/state');
  });

  it('the Removed fold opens, and Bring back reopens the line', async () => {
    const toggle = document.querySelector<HTMLButtonElement>('[data-fold="removed"]');
    expect(document.querySelector<HTMLElement>('[data-fold-body="removed"]')?.hidden).toBe(true);
    toggle?.click();
    expect(document.querySelector<HTMLElement>('[data-fold-body="removed"]')?.hidden).toBe(false);
    expect(toggle?.textContent).toBe('Hide 1 removed');
    document
      .querySelector<HTMLButtonElement>('[data-row="ib-cccccccccccc"] [data-act="reopen"]')
      ?.click();
    await until(() => posted('reopen').length === 1);
    expect(posted('reopen')[0]?.url).toBe('/inbox/rows/ib-cccccccccccc/state');
  });
});

describe('the key list', () => {
  const dialog = () => document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]');

  it('`?` opens it as a dialog naming `e`, and `?` again closes it', () => {
    expect(dialog()).toBeNull();
    key('?');
    expect(dialog()?.textContent).toContain('Remove');
    expect([...(dialog()?.querySelectorAll('dt') ?? [])].map((d) => d.textContent)).toContain('e');
    key('?');
    expect(dialog()).toBeNull();
  });

  it('Escape or a tap on the scrim closes it, and a tap inside does not', () => {
    key('?');
    key('Escape');
    expect(dialog()).toBeNull();
    key('?');
    dialog()?.querySelector<HTMLElement>('dl')?.click();
    expect(dialog()).not.toBeNull();
    document.querySelector<HTMLElement>('.inbox-modal-back')?.click();
    expect(dialog()).toBeNull();
  });

  it('keys other than `?` and Escape do nothing while it is open', () => {
    key('?');
    key('j');
    // A j that got through would put the cursor on the first line.
    expect(document.querySelector('.inbox-row-cursor')).toBeNull();
  });
});

describe('focus', () => {
  it('the section holds keyboard focus once the page loads, so keys reach it', () => {
    expect(document.activeElement?.id).toBe('inbox');
  });
});

describe('snoozeChoices', () => {
  const labels = (d: Date) => snoozeChoices(d).map(([l]) => l);

  it('offers Gmail’s four on a weekday at noon, at the right local times', () => {
    const wed = new Date(2026, 8, 30, 12, 30);
    const out = snoozeChoices(wed);
    expect(out.map(([l]) => l)).toEqual(['Later today', 'Tomorrow', 'This weekend', 'Next week']);
    expect(out.map(([, d]) => [d.getDay(), d.getHours()])).toEqual([
      [3, 18],
      [4, 8],
      [6, 8],
      [1, 8],
    ]);
  });

  it('drops the evening once it is near, and the weekend on the weekend', () => {
    expect(labels(new Date(2026, 8, 30, 17, 30))).not.toContain('Later today');
    expect(labels(new Date(2026, 9, 3, 10, 0))).not.toContain('This weekend');
    const sunday = snoozeChoices(new Date(2026, 9, 4, 10, 0));
    expect(sunday.find(([l]) => l === 'Next week')?.[1].getDate()).toBe(5);
  });
});
