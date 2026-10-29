/**
 * `/access` — who can sign in to every board, and the access changes agents
 * proposed (Bryan, 29 Oct: "only he can change who is in").
 *
 *   /access            every section
 *   /access/waiting    the proposals waiting for him
 *   /access/<boardId>  one board
 *
 * `?ws=<workspaceId>` is context, as on the prompts page: the board he came
 * from, for the back link and the rail. Below 1100px every section shows at
 * once, because there is no subnav to choose one with.
 *
 * It writes through the routes that already guard each write: Approve and
 * Reject through the card's own access door, which needs the owner's own
 * signed-in page and an echo of the change shown; Add and Remove through the
 * board's audience route. Each board's list is the board settings' own
 * module (`board/board-members.ts`), so the two cannot drift apart.
 *
 * Live: `access.changed` on `/api/access/events:stream` re-reads, and a
 * dropped stream re-reads when it reopens.
 */

import { escapeHtml } from '@claude-workspaces/core';
import {
  approveRequest,
  letInRequest,
  resumeAccessWrite,
  sendAccessWrite,
} from '../board/access-writes.ts';
import {
  type AccessWriteResult,
  type BoardAudienceEntry,
  type BoardMemberEntry,
  type BoardMembersHandle,
  type BoardMembersView,
  accessWriteOf,
  mountBoardMembers,
} from '../board/board-members.ts';

/** One proposal, as `GET /api/access` lists it. */
export interface AccessProposal {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  reviewItemId: string;
  change: { op: string; entries?: string[]; email?: string; role?: string };
  line: string;
  why: string;
  proposedBy: string;
  proposedAt: number;
  answer?: { text: string; by: string; ts: number; approved: boolean };
}

export interface AccessBoard {
  workspaceId: string;
  name: string;
  audience: BoardAudienceEntry[];
  people: BoardMemberEntry[];
}

export interface AccessData {
  boards: AccessBoard[];
  proposals: AccessProposal[];
}

export interface AccessRoute {
  /** 'all', 'waiting', or a board id. */
  section: string;
  workspaceId: string | null;
}

export function parseAccessRoute(pathname: string, search: string): AccessRoute {
  const m = pathname.match(/^\/access(?:\/([^/]+))?\/?$/);
  const ws = new URLSearchParams(search).get('ws');
  return {
    section: m?.[1] ? decodeURIComponent(m[1]) : 'all',
    workspaceId: ws && ws.trim() !== '' ? ws : null,
  };
}

export function accessHref(route: AccessRoute, section: string): string {
  const q = route.workspaceId ? `?ws=${encodeURIComponent(route.workspaceId)}` : '';
  return `/access${section === 'all' ? '' : `/${encodeURIComponent(section)}`}${q}`;
}

export interface AccessApi {
  read(): Promise<AccessData | null>;
  readBoard(workspaceId: string): Promise<BoardMembersView | null>;
  send(
    path: string,
    method: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }>;
}

export interface AccessPageDeps {
  document: Document;
  location: Pick<Location, 'pathname' | 'search'>;
  history: Pick<History, 'pushState'>;
  api: AccessApi;
  /** True at 1100px and below, where every section shows at once. */
  narrow: () => boolean;
}

export interface AccessPageHandle {
  render(): Promise<void>;
  /** Re-read because something changed elsewhere. */
  changed(): Promise<void>;
  /** Resolves when every write in flight has finished. Tests await it. */
  settled(): Promise<void>;
}

const BACK =
  '<svg class="settings-rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';

/** "14 min ago", "3 h ago", or the day. */
export function agoText(ts: number, now: number): string {
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** What Approve would do, in a sentence the owner can check against the card. */
export function changeSentence(p: AccessProposal): string {
  const entries = p.change.entries ?? [];
  if (p.change.op === 'set-role') {
    return `Makes ${p.change.email ?? 'them'} an Owner of this board, who can answer what only you could.`;
  }
  if (p.change.op === 'open-board') {
    return 'Everyone this board names can sign in again, and its links work again.';
  }
  if (p.change.op === 'unlock-board') {
    return 'Links can be minted for this board again. Nobody new is let in by this alone.';
  }
  if (p.change.op === 'sharing-on') {
    return 'Every board reopens to the people it names, except a board closed on its own. Nobody new is let in.';
  }
  const domain = entries.some((e) => e.startsWith('@'));
  const who = entries.join(', ');
  const tail = domain
    ? 'Each person there signs in with their own address, and their comments and answers count like yours.'
    : 'Their comments and answers will count like yours.';
  if (p.change.op === 'share-link')
    return `Mints a sign-in link for ${who || 'this board'}. ${tail}`;
  return `Adds ${who}. ${tail}`;
}

export function mountAccessPage(root: HTMLElement, deps: AccessPageDeps): AccessPageHandle {
  const doc = deps.document;
  let route = parseAccessRoute(deps.location.pathname, deps.location.search);
  let data: AccessData | null = null;
  let boardKey = '';
  const lists = new Map<string, BoardMembersHandle>();
  const writes = new Set<Promise<unknown>>();

  const el = (tag: string, cls: string, text?: string): HTMLElement => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function toast(message: string): void {
    const t = doc.getElementById('settings-toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    setTimeout(() => {
      t.hidden = true;
    }, 3500);
  }

  function track<T>(p: Promise<T>): Promise<T> {
    writes.add(p);
    void p.finally(() => writes.delete(p));
    return p;
  }

  function chrome(): void {
    const ws = route.workspaceId;
    const back = ws
      ? `<a class="settings-back" href="/workspaces/${encodeURIComponent(ws)}">${BACK}Board</a>`
      : `<a class="settings-back" href="/">${BACK}Workspaces</a>`;
    root.innerHTML =
      '<div class="settings-shell access-shell">' +
      '<div class="settings-page">' +
      `<header class="settings-topbar">${back}<h1>Who has access</h1></header>` +
      '<div class="settings-body-row">' +
      '<nav class="settings-subnav" aria-label="Boards" id="acc-subnav"></nav>' +
      '<div class="settings-main"><div class="settings-main-inner" id="settings-main">' +
      '<section id="acc-waiting" class="acc-section" data-sec="waiting">' +
      '<h2>Waiting for you</h2>' +
      '<div id="acc-proposals" class="acc-proposals"></div>' +
      '<div id="acc-answered" class="acc-answered"></div>' +
      '</section>' +
      '<div id="acc-boards"></div>' +
      '</div></div></div></div></div>' +
      '<div class="settings-toast" id="settings-toast" role="status" aria-live="polite" hidden></div>';
  }

  function subnav(): void {
    const nav = doc.getElementById('acc-subnav');
    if (!nav || !data) return;
    nav.textContent = '';
    const open = data.proposals.filter((p) => !p.answer).length;
    const sections: Array<[string, string]> = [
      ['all', 'All boards'],
      ['waiting', 'Waiting for you'],
      ...data.boards.map((b): [string, string] => [b.workspaceId, b.name]),
    ];
    for (const [id, label] of sections) {
      const a = el('a', '', label) as HTMLAnchorElement;
      a.href = accessHref(route, id);
      if (id === 'waiting') a.appendChild(el('span', 'acc-count', String(open)));
      if (route.section === id) a.setAttribute('aria-current', 'page');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        route = { ...route, section: id };
        deps.history.pushState(null, '', a.href);
        subnav();
        showSections();
      });
      nav.appendChild(a);
    }
  }

  function answer(p: AccessProposal, decision: 'approve' | 'reject', card: HTMLElement): void {
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    void track(
      (async () => {
        const path =
          `/workspaces/${encodeURIComponent(p.workspaceId)}/tasks/${encodeURIComponent(p.taskId)}` +
          `/review-items/${encodeURIComponent(p.reviewItemId)}/access`;
        // Approving widens who is in, so it asks for a recent sign-in.
        const res =
          decision === 'approve'
            ? await sendAccessWrite(approveRequest(path, p.change, p.line), deps.api.send, toast)
            : await deps.api.send(path, 'POST', { decision, access: p.change });
        if (!res) {
          await reload();
          return;
        }
        const said = res.data?.message;
        toast(
          res.ok
            ? decision === 'approve'
              ? `Approved. ${p.line}`
              : 'Rejected. Nothing changed.'
            : typeof said === 'string'
              ? said
              : 'Could not answer that card',
        );
        await reload();
      })(),
    );
  }

  function proposalCard(p: AccessProposal): HTMLElement {
    const board = data?.boards.find((b) => b.workspaceId === p.workspaceId);
    const sec = el('section', 'board-decide');
    sec.dataset.proposal = p.reviewItemId;
    const head = el('div', 'board-decide-head');
    head.appendChild(
      el('p', 'board-decide-kicker', `Access change · ${board?.name ?? p.workspaceId}`),
    );
    sec.appendChild(head);
    const card = el('div', 'board-decide-card');
    const ch = el('div', 'board-decide-card-head');
    ch.appendChild(el('span', 'board-decide-k board-decide-k-decision', 'Access'));
    ch.appendChild(el('p', 'board-decide-headline', p.line));
    const meta = el(
      'p',
      'board-decide-meta',
      `Proposed by ${p.proposedBy} · ${agoText(p.proposedAt, Date.now())} · `,
    );
    const task = el('a', '', p.taskTitle) as HTMLAnchorElement;
    task.href = `/workspaces/${encodeURIComponent(p.workspaceId)}?task=${encodeURIComponent(p.taskId)}`;
    meta.appendChild(task);
    ch.appendChild(meta);
    card.appendChild(ch);
    const body = el('div', 'board-decide-body');
    if (p.why) body.appendChild(el('p', '', p.why));
    body.appendChild(el('p', 'acc-change', changeSentence(p)));
    card.appendChild(body);
    const opts = el('div', 'board-decide-options');
    const wide = (p.change.entries ?? []).some((e) => e.startsWith('@'));
    const option = (decision: 'approve' | 'reject', label: string, detail: string) => {
      const b = el('button', 'board-decide-option') as HTMLButtonElement;
      if (decision === 'approve' && wide) b.classList.add('acc-wide');
      b.type = 'button';
      b.dataset.answer = decision;
      b.appendChild(el('span', 'board-decide-option-label', label));
      b.appendChild(el('span', 'board-decide-option-detail', detail));
      b.addEventListener('click', () => answer(p, decision, card));
      opts.appendChild(b);
    };
    option(
      'approve',
      'Approve',
      wide ? 'Lets in everyone at the domain, now' : 'Applies the change now',
    );
    option('reject', 'Reject', `Nothing changes, and ${p.proposedBy} is told`);
    card.appendChild(opts);
    sec.appendChild(card);
    return sec;
  }

  function paintProposals(): void {
    const props = doc.getElementById('acc-proposals');
    const answered = doc.getElementById('acc-answered');
    if (!props || !answered || !data) return;
    props.textContent = '';
    answered.textContent = '';
    const open = data.proposals.filter((p) => !p.answer);
    for (const p of open) props.appendChild(proposalCard(p));
    if (open.length === 0) props.appendChild(el('p', 'acc-empty', 'Nothing is waiting for you.'));
    const done = data.proposals.filter((p) => p.answer).slice(0, 10);
    if (done.length > 0) answered.appendChild(el('h3', 'acc-answered-head', 'Answered'));
    for (const p of done) {
      const row = el('div', 'acc-done');
      row.appendChild(el('strong', '', p.answer?.approved ? 'Approved' : 'Rejected'));
      row.appendChild(el('span', '', p.line));
      const board = data.boards.find((b) => b.workspaceId === p.workspaceId)?.name ?? '';
      row.appendChild(
        el('span', 'acc-via', `${board} · ${agoText(p.answer?.ts ?? 0, Date.now())}`),
      );
      answered.appendChild(row);
    }
  }

  function viewFor(b: AccessBoard): BoardMembersView {
    return {
      you: { email: null, role: 'owner' },
      members: b.people,
      audience: b.audience,
      openProposals: data?.proposals.filter((p) => p.workspaceId === b.workspaceId && !p.answer)
        .length,
    };
  }

  function boardSection(b: AccessBoard): HTMLElement {
    const ws = encodeURIComponent(b.workspaceId);
    const s = el('section', 'acc-board acc-section');
    s.dataset.sec = b.workspaceId;
    s.appendChild(el('h2', '', b.name));
    const note = el('p', 'acc-note');
    s.appendChild(note);
    s.appendChild(el('p', 'acc-sub', 'People'));
    const list = el('div', 'board-members');
    s.appendChild(list);
    const form = el('form', 'acc-add') as HTMLFormElement;
    form.autocomplete = 'off';
    const id = `acc-add-${b.workspaceId}`;
    form.innerHTML =
      `<label class="acc-sub" for="${escapeHtml(id)}">Add someone</label>` +
      `<input id="${escapeHtml(id)}" class="board-cap-input" name="match" type="text" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="name@company.com or @company.com" />` +
      '<button type="submit" class="prompt-btn prompt-btn-primary">Add</button>';
    s.appendChild(form);
    const error = el('p', 'acc-err');
    error.id = `${id}-error`;
    error.setAttribute('role', 'status');
    s.appendChild(error);
    const audience = async (body: unknown) =>
      track(deps.api.send(`/workspaces/${ws}/audience`, 'POST', body));
    const handle = mountBoardMembers({
      list,
      note,
      form,
      error,
      buttonClass: 'prompt-btn',
      read: async () => deps.api.readBoard(b.workspaceId),
      remove: async (match) => (await audience({ remove: [match] })).ok,
      add: async (match): Promise<AccessWriteResult> => {
        const res = await track(
          sendAccessWrite(letInRequest(b.workspaceId, match), deps.api.send, toast),
        );
        return res ? accessWriteOf(res) : { ok: false, message: 'Nothing changed.' };
      },
      toast,
    });
    handle.show(viewFor(b));
    lists.set(b.workspaceId, handle);
    return s;
  }

  function paintBoards(): void {
    const wrap = doc.getElementById('acc-boards');
    if (!wrap || !data) return;
    const key = data.boards.map((b) => b.workspaceId).join(',');
    if (key === boardKey) {
      for (const b of data.boards) lists.get(b.workspaceId)?.show(viewFor(b));
      return;
    }
    boardKey = key;
    lists.clear();
    wrap.textContent = '';
    if (data.boards.length === 0) {
      wrap.appendChild(el('p', 'acc-empty', 'Nobody else can sign in to any of your boards.'));
    }
    for (const b of data.boards) wrap.appendChild(boardSection(b));
  }

  function showSections(): void {
    const show = deps.narrow() ? 'all' : route.section;
    const waiting = doc.getElementById('acc-waiting');
    const known = show === 'all' || show === 'waiting' || lists.has(show);
    const pick = known ? show : 'all';
    waiting?.classList.toggle('hidden', !(pick === 'all' || pick === 'waiting'));
    let first = !(pick === 'all' || pick === 'waiting');
    for (const s of doc.querySelectorAll<HTMLElement>('#acc-boards .acc-board')) {
      const shown = pick === 'all' || pick === s.dataset.sec;
      s.classList.toggle('hidden', !shown);
      // The first section on screen carries no rule above it.
      s.classList.toggle('acc-lead', shown && first);
      if (shown) first = false;
    }
  }

  function paint(): void {
    const main = doc.getElementById('settings-main');
    if (!main) return;
    if (!data) {
      main.textContent = '';
      main.appendChild(
        el('p', 'acc-empty', 'Only the owner, signed in, can see who has access to every board.'),
      );
      return;
    }
    subnav();
    paintProposals();
    paintBoards();
    showSections();
  }

  async function reload(): Promise<void> {
    data = await deps.api.read();
    paint();
  }

  return {
    async render() {
      route = parseAccessRoute(deps.location.pathname, deps.location.search);
      chrome();
      boardKey = '';
      lists.clear();
      await reload();
      // Back from "Sign in again": offer the access change this page held.
      void track(
        resumeAccessWrite(deps.api.send, toast).then(async (sent) => {
          if (sent) await reload();
        }),
      );
      // Arriving from a board's settings opens on that board.
      const ws = route.workspaceId;
      if (route.section === 'all' && ws && lists.has(ws)) {
        route = { ...route, section: ws };
        subnav();
        showSections();
      }
    },
    changed: reload,
    async settled() {
      while (writes.size > 0) await Promise.all([...writes]);
    },
  };
}
