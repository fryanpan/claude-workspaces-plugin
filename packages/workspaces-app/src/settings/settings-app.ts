/**
 * The /settings/* entry point.
 *
 * The server-rendered shell provides `#settings-root`; everything else is
 * `mountPromptsPage`, which the tests drive directly. Same shape as
 * `signin/signin-app.ts` next door, and for the same reason: importing the
 * module must not BE running the app.
 */
import { ensureUserIdentity } from '../identity-prompt.ts';
import { mountAccessPage } from './access-page.ts';
import { createPromptsApi } from './prompts-api.ts';
import { mountPromptsPage, parsePromptsRoute } from './prompts-page.ts';

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function sendJson(path: string, method: string, body: unknown) {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** `/access`: the owner's page of who can reach every board. */
async function bootAccess(root: HTMLElement): Promise<void> {
  const narrow = window.matchMedia('(max-width: 1100px)');
  const page = mountAccessPage(root, {
    document,
    location,
    history,
    narrow: () => narrow.matches,
    api: {
      read: () => fetchJson('/api/access'),
      readBoard: (ws) => fetchJson(`/workspaces/${encodeURIComponent(ws)}/members`),
      send: sendJson,
    },
  });
  window.addEventListener('popstate', () => void page.render());
  narrow.addEventListener('change', () => void page.changed());
  // An agent's proposal, an answer or a removal anywhere redraws here
  // (`page-nudges.ts`); a dropped stream re-reads when it reopens.
  const stream = new EventSource('/api/access/events:stream');
  let dropped = false;
  stream.addEventListener('access.changed', () => void page.changed());
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('open', () => {
    if (dropped) void page.changed();
    dropped = false;
  });
  await page.render();
}

async function boot(): Promise<void> {
  const root = document.getElementById('settings-root');
  if (!root) return;
  if (/^\/access(?:\/|$)/.test(location.pathname)) {
    await bootAccess(root);
    return;
  }
  // No name prompt here. This page is the owner's own configuration, and a
  // modal asking who is reading it is a question nobody came here to answer.
  const user = await ensureUserIdentity(
    null,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    { suppressNamePrompt: true },
  );
  const route = parsePromptsRoute(location.pathname, location.search);
  const api = createPromptsApi({
    workspaceId: route.workspaceId,
    author: { id: user.id, name: user.name, ...(user.color ? { color: user.color } : {}) },
    fetchJson,
    async send(path: string, method: string, body: unknown) {
      const res = await sendJson(path, method, body);
      return { ok: res.ok, status: res.status, body: res.data };
    },
  });
  const page = mountPromptsPage(root, {
    document,
    location,
    history,
    api,
  });
  window.addEventListener('popstate', () => void page.render());
  // A prompt saved in another tab, or a board's criteria rewritten by an
  // agent, redraws here (`page-nudges.ts` on the server). A dropped stream
  // misses frames, so its reopening re-reads too.
  const prompts = new EventSource('/api/prompts/events:stream');
  let dropped = false;
  prompts.addEventListener('prompts.changed', () => void page.changed());
  prompts.addEventListener('error', () => {
    dropped = true;
  });
  prompts.addEventListener('open', () => {
    if (dropped) void page.changed();
    dropped = false;
  });
  await page.render();
}

void boot();
