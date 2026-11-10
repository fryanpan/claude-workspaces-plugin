/**
 * The plan doc's one floating control: Approve Plan, at the bottom of the
 * editor pane, wearing one of two faces:
 *
 *   Approve Plan    — the doc is a plan whose drafts are held. Keyed on
 *                     `planState` ALONE, not on the huddle kind: an agent can
 *                     mark any doc a pending plan and the approval must show.
 *   ✓ Plan Approved — the few seconds after a press, naming what the release
 *                     actually did. Then it goes away for good.
 *
 * It used to open with a third face, "Make Plan", on every unasked meeting or
 * plan doc, beside a Review float. Bryan removed both on 2026-11-09 ("They're
 * really confusing"): a person asks for a plan or a review the way they ask
 * for anything else, in a comment, and the doc carries no button for it.
 *
 * The tasks a doc produced read through the links written in its prose
 * (task-link-chips.ts decorates those, including the held-draft state), so
 * the only chrome left is this float — anchored to `#editor-pane` rather than
 * the viewport so it stays clear of the doc-list sidebar on desktop.
 *
 * Live: one event stream per board the held drafts live on, so an approval
 * from ANYWHERE (another tab, an agent over MCP) releases the drafts, fires
 * their transitions, and this button hides itself rather than offering a
 * stale Approve.
 */

import type { User } from '@claude-workspaces/core';
import { api, docJsonUrl } from './doc-path.ts';
import type { DocRecordReader } from './doc/doc-record.ts';
import { floatDock } from './float-dock.ts';

/** How long "✓ Plan Approved" stays before the doc is just a doc again. It
 *  is a receipt for a press the person just made, not a state to live in. */
const APPROVED_NOTICE_MS = 6000;

export interface PlanGateOpts {
  docId: string;
  /** The doc's editor pane — the float anchors to its `position: relative`
   *  so it pins to the visible pane, not to the scrolling prose. A bare
   *  root (a test, a stripped embed) anchors it to `root` itself. */
  root: HTMLElement;
  user: User;
  canWrite: boolean;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  /** The doc record, shared with the Review float and seeded by the router's
   *  read (`doc/doc-record.ts`). Absent, every load reads through `fetchJson`. */
  record?: Pick<DocRecordReader, 'read' | 'invalidate'>;
  subscribe?: (workspaceId: string, onTaskEvent: () => void) => () => void;
  /**
   * Watch the doc's own metadata for a change, and re-read when one lands.
   *
   * This is how the float learns the plan ARRIVED. The board streams below
   * carry `task.transitioned` and `task.created` and nothing else, and
   * `POST /plan {state:'pending'}` fires neither — only the `approved` branch
   * touches the task projection. So without this a doc that became a pending
   * plan would show no Approve until a reload.
   *
   * The signal it needs is already there: `setPlanState` writes `planState`
   * into the doc's Yjs `meta` map, and this client is connected to that doc.
   * Observing the map turns the arrival into a live flip with no new server
   * surface. Injected rather than reached for so a test drives it without Yjs.
   */
  watchDocMeta?: (onChange: () => void) => () => void;
  /** Injected so a test can retire the approved notice without waiting on a
   *  real clock. Defaults to the real timers. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** Which face the float is wearing, or `'none'` when there is no float. */
export type PlanFloatFace = 'none' | 'approve' | 'approved';

export interface PlanGateHandle {
  destroy(): void;
  planState(): string | undefined;
  /** Which face is showing — the whole render decision, for a test to read. */
  face(): PlanFloatFace;
  /** The initial load, so a test can await the first render. */
  ready: Promise<void>;
}

interface DocAnswer {
  meta?: {
    planState?: string;
  };
  tasks?: Array<{ planHeld?: boolean; workspaceId?: string }>;
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function defaultSubscribe(workspaceId: string, onTaskEvent: () => void): () => void {
  const es = new EventSource(`/workspaces/${encodeURIComponent(workspaceId)}/events:stream`);
  // Transitions are how an approval reaches this button (the release moves
  // the held rows); creates matter too — an agent filing more drafts while
  // the doc is open changes the count, though the count no longer renders.
  es.addEventListener('task.transitioned', onTaskEvent);
  es.addEventListener('task.created', onTaskEvent);
  return () => {
    es.removeEventListener('task.transitioned', onTaskEvent);
    es.removeEventListener('task.created', onTaskEvent);
    es.close();
  };
}

/** The receipt's second line. The release reports the rows it moved and
 *  nothing else, so this claims tickets and never a goal — a plan that
 *  released no held row gets no second line rather than a made-up one. */
function approvedSubLabel(released: number): string {
  if (released <= 0) return '';
  return `${released} ticket${released === 1 ? '' : 's'} created — work started`;
}

export function mountPlanGate(opts: PlanGateOpts): PlanGateHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  // POST ONLY — the press hangs `/plan` off this. A GET here gets
  // the editor's HTML page, which is the bug `docJsonUrl` exists to close.
  const docPostBase = api(`docs/${encodeURIComponent(docId)}`);
  // The RECORD. Same path, and only the query asks for data.
  const docReadUrl = docJsonUrl(docId);
  const record = opts.record ?? { read: () => fetchJson(docReadUrl), invalidate: () => {} };

  const float = document.createElement('button');
  float.type = 'button';
  float.className = 'plan-float';
  float.hidden = true;
  const labelEl = document.createElement('span');
  labelEl.className = 'plan-float-label';
  const subEl = document.createElement('span');
  subEl.className = 'plan-float-sub';
  float.append(labelEl, subEl);

  const error = document.createElement('span');
  error.className = 'plan-gate-error';
  // Assertive: only ever appears in answer to a press.
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;

  // Anchors to `#editor-pane`'s `position: relative` so it pins to the
  // visible pane whatever the scroll position; a bare root (a test) anchors
  // it to itself instead.
  const anchor = root.closest('#editor-pane') ?? root;
  // Into the pane's shared float dock (float-dock.ts): the row at the bottom
  // of the pane. The error stays on the pane itself.
  floatDock(anchor).append(float);
  anchor.append(error);

  let state: string | undefined;
  let loaded = false;
  let busy = false;
  let disposed = false;
  /** Set only for the seconds after a press HERE, and it outranks the meta
   *  while it stands — the doc reads `approved` the instant the POST lands,
   *  and without this the receipt would never get a frame. */
  let approvedNotice: number | null = null;
  let noticeTimer: number | undefined;
  const streams = new Map<string, () => void>();

  function faceFor(): PlanFloatFace {
    if (!canWrite || !loaded) return 'none';
    if (approvedNotice !== null) return 'approved';
    return state === 'pending' ? 'approve' : 'none';
  }

  function render(): void {
    const face = faceFor();
    float.hidden = face === 'none';
    float.disabled = busy || face === 'approved';
    float.dataset.face = face;
    // One class per face so the stylesheet can colour them apart; the base
    // class carries the shape and the `[hidden]` guard.
    float.classList.toggle('plan-float--approve', face === 'approve');
    float.classList.toggle('plan-float--done', face === 'approved');
    if (face === 'approve') {
      labelEl.textContent = 'Approve Plan';
      subEl.textContent = 'Creates the goal and tickets, starts work';
    } else if (face === 'approved') {
      labelEl.textContent = '✓ Plan Approved';
      subEl.textContent = approvedSubLabel(approvedNotice ?? 0);
    }
    // An empty second line must not reserve its own row.
    subEl.hidden = subEl.textContent === '';
    if (face !== 'approve') error.hidden = true;
  }

  /** One stream per board the held drafts live on; boards that dropped out
   *  of the answer are closed rather than accumulating. Streams are only
   *  needed while the gate is live — an approved plan closes them all. */
  function syncStreams(boards: Set<string>): void {
    if (state !== 'pending') boards.clear();
    for (const [wsId, stop] of streams) {
      if (!boards.has(wsId)) {
        stop();
        streams.delete(wsId);
      }
    }
    for (const wsId of boards) {
      if (!streams.has(wsId)) {
        streams.set(
          wsId,
          subscribe(wsId, () => {
            if (!disposed) void load({ fresh: true });
          }),
        );
      }
    }
  }

  /** `fresh` when something the synced meta map does not describe moved — a
   *  press here, a task event on a board — so a shared answer would be old. */
  async function load({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    if (fresh) record.invalidate();
    try {
      const body = (await record.read()) as DocAnswer;
      if (disposed) return;
      state = body.meta?.planState;
      loaded = true;
      const tasks = body.tasks ?? [];
      render();
      syncStreams(
        new Set(tasks.map((t) => t.workspaceId).filter((w): w is string => w !== undefined)),
      );
    } catch {
      // A server that cannot answer leaves the gate as it was; the doc
      // still works.
    }
  }

  /** The press: refuse while busy or unloaded, clear the last
   *  refusal, run, reload, and put a failure where the press was. */
  function press(run: () => Promise<unknown>): void {
    if (busy || !loaded) return;
    error.hidden = true;
    error.textContent = '';
    busy = true;
    render();
    void run()
      .then(() => load({ fresh: true }))
      .catch((err: Error) => {
        error.textContent = err.message;
        error.hidden = false;
      })
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  }

  float.addEventListener('click', () => {
    if (faceFor() !== 'approve') return;
    press(async () => {
      const res = (await fetchJson(`${docPostBase}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'approved', author: user }),
      })) as { released?: unknown[] };
      // The receipt counts what the RELEASE reported, not what the doc
      // guessed: a plan whose rows were already moved releases none, and
      // saying "3 tickets" there would be a lie the doc cannot back up.
      approvedNotice = Array.isArray(res?.released) ? res.released.length : 0;
      if (noticeTimer !== undefined) clearTimer(noticeTimer);
      noticeTimer = setTimer(() => {
        approvedNotice = null;
        noticeTimer = undefined;
        if (!disposed) render();
      }, APPROVED_NOTICE_MS);
    });
  });

  const ready = load();

  // The doc's own metadata, watched from mount — this is what carries the
  // plan's ARRIVAL (see `watchDocMeta`). Unconditional rather than gated on a
  // face: the gate that used to decide when to listen is the bug.
  const stopMetaWatch = opts.watchDocMeta?.(() => {
    if (!disposed) void load();
  });

  return {
    destroy(): void {
      disposed = true;
      stopMetaWatch?.();
      if (noticeTimer !== undefined) clearTimer(noticeTimer);
      for (const stop of streams.values()) stop();
      streams.clear();
      float.remove();
      error.remove();
    },
    planState: () => state,
    face: faceFor,
    ready,
  };
}
