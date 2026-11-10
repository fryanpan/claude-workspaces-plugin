/**
 * The plan doc's floating control (src/plan-gate.ts) and its two faces:
 * Approve Plan while the drafts are held, and the ✓ Plan Approved receipt
 * for the seconds after a press. Make Plan and Plan requested are asserted
 * GONE (Bryan, 2026-11-09). The one-line bar and the derived-work chip
 * strip it replaced are asserted GONE — links in the prose carry task status
 * now (task-link-chips), so nothing renders above the prose on an ordinary
 * doc.
 *
 * Driven entirely through the injected fetch seam — no server, and the
 * receipt's timer is injected too so nothing here sleeps. Fixtures are
 * synthetic (jordan@partner.example register).
 */
import type { User } from '@claude-workspaces/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPlanGate } from '../src/plan-gate.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

/** The board the page is standing on — every resource route is under it. */
const WS = 'w-1';

let root: HTMLElement;
beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/docs/d-gate`);
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

interface DocAnswer {
  meta?: {
    planState?: string;
    huddleKind?: string;
    /** Not read by the gate — here so a fixture can change something in the
     *  meta map that ISN'T the plan, which is the negative control for the
     *  watcher: the RE-READ decides, not the event. */
    title?: string;
  };
  tasks?: Array<{ id: string; planHeld?: boolean; workspaceId?: string }>;
  leadAgentId?: string;
}

/** A fetch stub that answers the doc GET from `answers` in order (the last
 *  one repeats), records every call, and accepts every POST with `post`. */
function stubFetch(answers: DocAnswer[], post: unknown = { released: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reads = 0;
  const fetchJson = (url: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ url, init });
    if (init?.method === 'POST') return Promise.resolve(post);
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return Promise.resolve(answer);
  };
  return { fetchJson, calls };
}

/**
 * A fetch stub that answers the way the SERVER does: `/workspaces/<ws>/docs/<id>`
 * is the editor PAGE, and only `?format=json` asks for the doc's record. A
 * reader that spells the address without the query gets an HTML shell under a
 * 200, and `defaultFetchJson` turns an unparseable 200 into `{}` — a read that
 * neither throws nor carries anything.
 *
 * That is not a hypothetical stub: it is what the doc surface did in
 * production after the address cutover moved the record onto the page's path,
 * and it is why a plan huddle opened with no planning flow in it. So this is
 * the fixture the gate has to survive.
 */
function serverShapedFetch(
  record: DocAnswer,
): (url: string, init?: RequestInit) => Promise<unknown> {
  return (url: string, init?: RequestInit): Promise<unknown> => {
    if (init?.method === 'POST') return Promise.resolve({ released: [] });
    return Promise.resolve(url.includes('format=json') ? record : {});
  };
}

/** Hand-cranked timers, so the receipt's expiry is a step in the test rather
 *  than six real seconds of waiting. */
function stubTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const h = next++;
      pending.set(h, fn);
      return h;
    },
    clearTimer: (h: number) => {
      pending.delete(h);
    },
    /** Fire every timer that is still armed. */
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
}

function approveBtn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.plan-float');
}
function label(): string | undefined {
  return approveBtn()?.querySelector('.plan-float-label')?.textContent ?? undefined;
}
function sub(): string | undefined {
  return approveBtn()?.querySelector('.plan-float-sub')?.textContent ?? undefined;
}

describe('mountPlanGate', () => {
  it('renders nothing for an ordinary doc — even one with derived rows', async () => {
    const gate = mountPlanGate({
      docId: 'd-plain',
      root,
      user: JORDAN,
      canWrite: true,
      // Rows but no pending plan: the old strip showed chips here; the
      // float must not — the prose's own links carry that now.
      fetchJson: stubFetch([{ meta: {}, tasks: [{ id: 't-1' }] }]).fetchJson,
    });
    await gate.ready;
    expect(approveBtn()?.hidden).toBe(true);
    expect(document.querySelector('.plan-task-chip')).toBeNull();
    gate.destroy();
  });

  it('shows the floating Approve button for writers on a pending plan', async () => {
    const gate = mountPlanGate({
      docId: 'd-plan',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([
        {
          meta: { planState: 'pending' },
          tasks: [{ id: 't-a', planHeld: true }, { id: 't-b', planHeld: true }, { id: 't-c' }],
        },
      ]).fetchJson,
    });
    await gate.ready;
    const btn = approveBtn();
    expect(btn?.hidden).toBe(false);
    expect(gate.face()).toBe('approve');
    // Label plus the subtitle that makes the press predictable — no
    // held-drafts count, no checkmark (Bryan, on the mock).
    expect(btn?.querySelector('.plan-float-label')?.textContent).toBe('Approve Plan');
    expect(btn?.querySelector('.plan-float-sub')?.textContent).toBe(
      'Creates the goal and tickets, starts work',
    );
    gate.destroy();
  });

  it('a reader without write access sees no Approve button', async () => {
    const gate = mountPlanGate({
      docId: 'd-ro',
      root,
      user: JORDAN,
      canWrite: false,
      fetchJson: stubFetch([
        { meta: { planState: 'pending' }, tasks: [{ id: 't-a', planHeld: true }] },
      ]).fetchJson,
    });
    await gate.ready;
    expect(approveBtn()?.hidden).toBe(true);
    gate.destroy();
  });

  it('anchors to #editor-pane when present, so it pins to the visible pane', async () => {
    const pane = document.createElement('section');
    pane.id = 'editor-pane';
    const editorEl = document.createElement('div');
    editorEl.id = 'editor';
    pane.append(editorEl);
    document.body.replaceChildren(pane);
    const gate = mountPlanGate({
      docId: 'd-anchor',
      root: editorEl,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([{ meta: { planState: 'pending' }, tasks: [] }]).fetchJson,
    });
    await gate.ready;
    expect(approveBtn()?.closest('#editor-pane')).toBe(pane);
    gate.destroy();
  });

  it('Approve posts, reloads, shows the receipt, and then the button goes for good', async () => {
    const stub = stubFetch(
      [
        { meta: { planState: 'pending' }, tasks: [{ id: 't-a', planHeld: true }] },
        { meta: { planState: 'approved' }, tasks: [{ id: 't-a' }] },
      ],
      // What the release actually moved — the receipt counts THIS.
      { released: ['t-a', 't-b', 't-c'] },
    );
    const timers = stubTimers();
    const gate = mountPlanGate({
      docId: 'd-gate',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await gate.ready;
    approveBtn()?.click();
    await vi.waitFor(() => expect(gate.planState()).toBe('approved'));
    const post = stub.calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe(`/workspaces/${WS}/docs/d-gate/plan`);
    expect(JSON.parse(String(post?.init?.body))).toEqual({ state: 'approved', author: JORDAN });

    // The receipt, naming what the release reported and claiming no goal —
    // the release does not report one.
    await vi.waitFor(() => expect(gate.face()).toBe('approved'));
    expect(approveBtn()?.hidden).toBe(false);
    expect(label()).toBe('✓ Plan Approved');
    expect(sub()).toBe('3 tickets created — work started');
    expect(sub()).not.toContain('Goal');
    // Not a control any more.
    expect(approveBtn()?.disabled).toBe(true);

    // …and it is a receipt, not a state: when its timer fires it is gone.
    expect(timers.armed()).toBe(1);
    timers.flush();
    expect(gate.face()).toBe('none');
    expect(approveBtn()?.hidden).toBe(true);
    gate.destroy();
  });

  it('a release that moved nothing gets no invented second line', async () => {
    const stub = stubFetch(
      [
        { meta: { planState: 'pending' }, tasks: [] },
        { meta: { planState: 'approved' }, tasks: [] },
      ],
      { released: [] },
    );
    const timers = stubTimers();
    const gate = mountPlanGate({
      docId: 'd-none',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await gate.ready;
    approveBtn()?.click();
    await vi.waitFor(() => expect(gate.face()).toBe('approved'));
    expect(label()).toBe('✓ Plan Approved');
    expect(sub()).toBe('');
    expect(approveBtn()?.querySelector<HTMLElement>('.plan-float-sub')?.hidden).toBe(true);
    gate.destroy();
  });

  it('flips to Approve when the plan lands, with no reload', async () => {
    // The measured bug: the float sat unchanged for 12s after the agent had
    // already set the plan pending, because the only subscription it ever
    // opened was gated on state==='pending' — which it could not yet know —
    // and nothing else re-read. It took a reload to advance.
    //
    // The doc's own meta map is what carries the arrival, so the watcher is
    // driven here the way Yjs drives it: fire, and the gate re-reads.
    let fire: (() => void) | undefined;
    let stopped = false;
    const stub = stubFetch([
      { meta: { huddleKind: 'plan' }, tasks: [] },
      { meta: { huddleKind: 'plan', planState: 'pending' }, tasks: [] },
    ]);
    const gate = mountPlanGate({
      docId: 'd-live',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      watchDocMeta: (onChange) => {
        fire = onChange;
        return () => {
          stopped = true;
        };
      },
    });
    await gate.ready;
    expect(gate.face()).toBe('none');
    // The watch is armed from mount, not from a state the client can't reach.
    expect(fire).toBeTypeOf('function');

    fire?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.face()).toBe('approve');
    expect(label()).toBe('Approve Plan');
    gate.destroy();
    expect(stopped).toBe(true);
  });

  it('a meta change that is NOT the plan leaves the face alone', async () => {
    // The negative control for the test above. The watcher fires on ANY
    // change to the doc's meta map — a title edit, a speaker rename — because
    // the map is one object and Yjs does not offer a per-key observer worth
    // the complexity here. So the re-read has to be what decides, not the
    // event: a fire whose re-read still says no plan must leave the float
    // exactly where it was. Without this, "it advanced" and "it advances on
    // any twitch" are the same passing test.
    let fire: (() => void) | undefined;
    const stub = stubFetch([
      { meta: { huddleKind: 'plan' }, tasks: [] },
      // The doc changed — its title did — and the plan did NOT arrive.
      {
        meta: { huddleKind: 'plan', title: 'Renamed while we waited' },
        tasks: [],
      },
    ]);
    const gate = mountPlanGate({
      docId: 'd-live',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      watchDocMeta: (onChange) => {
        fire = onChange;
        return () => {};
      },
    });
    await gate.ready;
    expect(gate.face()).toBe('none');

    fire?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.face()).toBe('none');
    expect(approveBtn()?.hidden).toBe(true);
    gate.destroy();
  });

  for (const huddleKind of ['plan', 'discussion']) {
    it(`offers no Make Plan on a ${huddleKind} meeting's notes, even to a writer`, async () => {
      // Bryan, 2026-11-09: "They're really confusing". A person asks for a
      // plan in a comment; the doc carries no button for it.
      const stub = stubFetch([{ meta: { huddleKind }, tasks: [], leadAgentId: 'Workspaces' }]);
      const gate = mountPlanGate({
        docId: 'd-notes',
        root,
        user: JORDAN,
        canWrite: true,
        fetchJson: stub.fetchJson,
      });
      await gate.ready;
      expect(gate.face()).toBe('none');
      expect(approveBtn()?.hidden).toBe(true);
      approveBtn()?.click();
      expect(stub.calls.some((c) => c.init?.method === 'POST')).toBe(false);
      gate.destroy();
    });
  }

  it('a refused Approve stays visible with the reason, floating above the button', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchJson = (_url: string, init?: RequestInit): Promise<unknown> => {
      calls.push(init);
      if (init?.method === 'POST') return Promise.reject(new Error('Plan already approved.'));
      return Promise.resolve({ meta: { planState: 'pending' }, tasks: [] });
    };
    const gate = mountPlanGate({
      docId: 'd-refuse',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson,
    });
    await gate.ready;
    approveBtn()?.click();
    await vi.waitFor(() => expect(calls.some((c) => c?.method === 'POST')).toBe(true));
    await vi.waitFor(() => {
      const err = document.querySelector<HTMLElement>('.plan-gate-error');
      expect(err?.hidden).toBe(false);
      expect(err?.textContent).toBe('Plan already approved.');
    });
    expect(approveBtn()?.hidden).toBe(false);
    gate.destroy();
  });

  it('an approval from ANYWHERE reaches it: a board task event reloads, then closes the stream', async () => {
    const stub = stubFetch([
      {
        meta: { planState: 'pending' },
        tasks: [{ id: 't-a', planHeld: true, workspaceId: 'w-test' }],
      },
      { meta: { planState: 'approved' }, tasks: [{ id: 't-a', workspaceId: 'w-test' }] },
    ]);
    const stops: string[] = [];
    const live: { poke?: () => void } = {};
    const subscribe = vi.fn((wsId: string, onEvent: () => void) => {
      live.poke = onEvent;
      return () => stops.push(wsId);
    });
    const gate = mountPlanGate({
      docId: 'd-remote',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      subscribe,
    });
    await gate.ready;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('w-test', expect.any(Function));
    expect(approveBtn()?.hidden).toBe(false); // control
    // The release's transition event lands: no press happened HERE, yet the
    // stale Approve must go away…
    live.poke?.();
    await vi.waitFor(() => expect(approveBtn()?.hidden).toBe(true));
    expect(gate.planState()).toBe('approved');
    // …and an approved plan needs no stream any more.
    expect(stops).toEqual(['w-test']);
    gate.destroy();
  });
  it('offers Approve on a pending plan read from a server that also serves a page there', async () => {
    const gate = mountPlanGate({
      docId: 'd-plan',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: serverShapedFetch({ meta: { planState: 'pending' }, tasks: [] }),
    });
    await gate.ready;
    expect(gate.face()).toBe('approve');
    expect(label()).toBe('Approve Plan');
    gate.destroy();
  });
});
