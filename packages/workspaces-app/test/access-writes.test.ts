/**
 * Letting someone in and approving an access card ask for a recent sign-in
 * (`src/board/access-writes.ts`), through each page's own `send`.
 *
 * Driven with a fake `send`, so each case names what the server answered and
 * reads what the page then asked and sent. All fixtures are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveRequest,
  letInRequest,
  resumeAccessWrite,
  sendAccessWrite,
} from '../src/board/access-writes.ts';

const STALE = { ok: false, status: 403, data: { error: 'confirm-required', window: 600 } };
const APPLIED = { ok: true, status: 200, data: { ok: true } };

function title(): string | null {
  return document.querySelector('.fresh-signin-prompt .identity-card h2')?.textContent ?? null;
}

async function press(on: string, label: string): Promise<void> {
  await vi.waitFor(() => expect(title()).toBe(on));
  const b = [...document.querySelectorAll<HTMLButtonElement>('.fresh-signin-prompt button')].find(
    (x) => x.textContent === label,
  );
  if (!b) throw new Error(`no ${label} on ${on}`);
  b.click();
}

afterEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
});

describe('the access writes that widen who is in', () => {
  it('a recent sign-in lets someone in at once, asking nothing', async () => {
    const send = vi.fn(async () => APPLIED);
    const reply = await sendAccessWrite(letInRequest('w-1', '@riverbend.test'), send, vi.fn());
    expect(reply).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(send).toHaveBeenCalledWith('/workspaces/w-1/audience', 'POST', {
      add: ['@riverbend.test'],
    });
    expect(title()).toBeNull();
  });

  it('a stale one asks "Confirm it\'s you", and Cancel sends nothing more', async () => {
    const send = vi.fn(async () => STALE);
    const toast = vi.fn();
    const pending = sendAccessWrite(letInRequest('w-1', '@riverbend.test'), send, toast);
    await press("Confirm it's you", 'Cancel');
    expect(await pending).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Nothing changed');
  });

  it('an approval echoes the change the card showed', async () => {
    const send = vi.fn(async () => APPLIED);
    const change = { op: 'add-audience', entries: ['@harborlight.example'] };
    const path = '/workspaces/w-1/tasks/t-1/review-items/r-1/access';
    await sendAccessWrite(approveRequest(path, change, 'Lets everyone in.'), send, vi.fn());
    expect(send).toHaveBeenCalledWith(path, 'POST', { decision: 'approve', access: change });
  });

  it('back from signing in, offers the held add once and says it landed', async () => {
    sessionStorage.setItem(
      'cw-held-action',
      JSON.stringify({
        request: letInRequest('w-1', '@riverbend.test'),
        page: `${location.pathname}${location.search}`,
        at: Date.now(),
      }),
    );
    const send = vi.fn(async () => APPLIED);
    const toast = vi.fn();
    const pending = resumeAccessWrite(send, toast);
    await press('Let in @riverbend.test now?', 'Let in');
    expect(await pending).toBe(true);
    expect(send).toHaveBeenCalledWith('/workspaces/w-1/audience', 'POST', {
      add: ['@riverbend.test'],
    });
    expect(toast).toHaveBeenCalledWith('@riverbend.test can now sign in');
    expect(await resumeAccessWrite(send, toast)).toBe(false);
  });
});
