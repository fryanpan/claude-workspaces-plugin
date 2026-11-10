import type { User } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountDocFloats } from '../src/doc/doc-floats.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The always-in-view float a document carries (doc/doc-floats.ts): Approve,
 * the plan gate. Meeting-notes and plan docs carried Make Plan and Review
 * beside it until Bryan removed them (2026-11-09, "They're really
 * confusing"); the first block below holds that.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
});

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const floats = () => [...document.querySelectorAll('#editor-pane .plan-float')];

/** Answers every read with `meta` (a plain markdown doc by default), and
 *  counts the reads. */
function stubFetch(meta: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ meta, leadAgentId: 'harbor-agent' }) } as Response;
    }),
  );
  return calls;
}

function mount(meta: Record<string, unknown> = {}) {
  const calls = stubFetch(meta);
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  mountDocFloats({
    docId: 'd1',
    root: document.getElementById('editor') as HTMLElement,
    ydoc,
    user: testUser,
    canWrite: true,
    scope,
  });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, calls };
}

/** Every float button on the pane that a person can see. */
const shown = () => floats().filter((f) => !(f as HTMLElement).hidden);
const labels = () =>
  [...document.querySelectorAll('#editor-pane button')].map((b) => b.textContent);

describe('meeting-notes and plan docs', () => {
  for (const huddleKind of ['plan', 'discussion']) {
    it(`a ${huddleKind} meeting's notes show neither Make Plan nor Review`, async () => {
      const { calls } = mount({ type: 'markdown', huddle: true, huddleKind });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      // Let the read's answer render.
      await new Promise((r) => setTimeout(r, 0));
      expect(shown()).toHaveLength(0);
      expect(labels().some((t) => /Make Plan|Plan requested|Review/.test(t ?? ''))).toBe(false);
      expect(document.querySelector('.review-float')).toBeNull();
    });
  }

  it('a plan an agent marked pending still offers Approve', async () => {
    mount({ type: 'markdown', huddle: true, huddleKind: 'plan', planState: 'pending' });
    await vi.waitFor(() => expect(shown()).toHaveLength(1));
    expect(shown()[0]?.textContent).toContain('Approve Plan');
  });
});

describe('the float row', () => {
  it('mounts one float, the plan gate, hidden until something needs doing', () => {
    mount();
    const row = floats();
    expect(row).toHaveLength(1);
    expect((row[0] as HTMLElement).hidden).toBe(true);
  });
});

describe('the metadata watch', () => {
  it('re-reads the doc when its meta map changes', async () => {
    const { ydoc, calls } = mount();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;
    // `setPlanState` writes into this same map on the server; observing it is
    // how the float hears that the plan landed — no event stream carries it.
    ydoc.getMap('meta').set('planState', 'approved');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('stops watching when the mount is torn down', async () => {
    const { ydoc, scope, calls } = mount();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    scope.dispose();
    const after = calls.length;
    ydoc.getMap('meta').set('planState', 'approved');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(after);
  });
});

describe('teardown', () => {
  it('takes the float off the pane', () => {
    const { scope } = mount();
    expect(floats()).toHaveLength(1);
    scope.dispose();
    expect(floats()).toHaveLength(0);
  });
});
