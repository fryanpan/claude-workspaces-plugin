/**
 * "Your coach" on the front page: what its buttons do. The server draws the
 * section (`packages/server/src/coach/section.ts`); after every answer the
 * section is re-read from `/` and swapped in whole, so the page never shows a
 * state the server does not hold.
 *
 *  - "Set up my coach" makes the learning-goals doc and opens it, where Talk
 *    starts the interview.
 *  - "Add a goal" adds an empty goal to that doc.
 *  - "No update needed" answers the weekly offer.
 *  - Less / Normal / More sets how readily the coach speaks up.
 */

const SECTION = '#coach';

const section = (): HTMLElement | null => document.querySelector<HTMLElement>(SECTION);

async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/', { credentials: 'same-origin' });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector(SECTION);
    const here = section();
    if (fresh && here) here.replaceWith(document.importNode(fresh, true));
  } catch {
    // The page keeps what it showed; the next load corrects it.
  }
}

function setBusy(busy: boolean): void {
  for (const b of section()?.querySelectorAll<HTMLButtonElement>('button') ?? []) b.disabled = busy;
}

/** The request a button makes, or null for a click that is not ours. */
function requestFor(btn: HTMLButtonElement): { url: string; body: unknown } | null {
  if (btn.dataset.act === 'setup') return { url: '/coach/setup', body: {} };
  if (btn.dataset.act === 'add-goal') return { url: '/coach/goals/add', body: {} };
  if (btn.dataset.review === 'no-update')
    return { url: '/coach/review', body: { answer: 'no-update' } };
  if (btn.dataset.readiness)
    return { url: '/coach/prefs', body: { readiness: btn.dataset.readiness } };
  return null;
}

async function onClick(ev: MouseEvent): Promise<void> {
  const btn = (ev.target as Element | null)?.closest<HTMLButtonElement>('button');
  if (!btn || !section()?.contains(btn)) return;
  const request = requestFor(btn);
  if (!request) return;
  setBusy(true);
  const res = await post(request.url, request.body);
  if (!res) return setBusy(false);
  if (btn.dataset.act === 'setup') {
    const { url } = (await res.json().catch(() => ({}))) as { url?: unknown };
    if (typeof url === 'string' && url.startsWith('/')) {
      location.assign(url);
      return;
    }
  }
  await refresh();
}

/** Wire the section, when the page carries it. Listens on the document so a
 *  swapped-in section needs no re-wiring. Returns the unwiring. */
export function startCoach(): () => void {
  if (!section()) return () => {};
  const listener = (ev: MouseEvent) => void onClick(ev);
  document.addEventListener('click', listener);
  return () => document.removeEventListener('click', listener);
}
