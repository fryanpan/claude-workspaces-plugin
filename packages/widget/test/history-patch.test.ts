import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A doc page that moves between docs in place removes its widget and adds
 * one for the next doc, in the same tab, for hours. Each widget used to wrap
 * `history.pushState` / `replaceState` and add its own popstate listener, and
 * nothing undid it, so N moves left N wrappers each telling a removed widget
 * about every route change. Driven over happy-dom with the socket stubbed.
 */

beforeAll(async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
    new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  await import('../src/widget.ts');
});

afterEach(() => {
  for (const el of document.querySelectorAll('claude-feedback-widget')) el.remove();
});

/** What the doc page does on a move: drop the old widget, mount the next. */
function moveTo(docId: string): FeedbackWidgetEl {
  for (const el of document.querySelectorAll('claude-feedback-widget')) el.remove();
  history.pushState(null, '', `/workspaces/w-1/docs/${docId}`);
  const el = document.createElement('claude-feedback-widget') as FeedbackWidgetEl;
  el.setAttribute('workspace-id', 'w-1');
  el.setAttribute('doc-id', docId);
  document.body.append(el);
  return el;
}

describe('in-place doc moves', () => {
  it('leave one widget and one history wrapper after three moves', () => {
    const first = moveTo('harborlight-notes');
    const wrapper = history.pushState;
    const second = moveTo('riverbend-plan');
    const third = moveTo('saltmarsh-brief');

    expect(document.querySelectorAll('claude-feedback-widget')).toHaveLength(1);
    expect(history.pushState).toBe(wrapper);
    expect(history.replaceState).toBeTypeOf('function');

    // A route change reaches the widget on the page and no removed one.
    history.pushState(null, '', '/workspaces/w-1/docs/saltmarsh-brief?thread=t1');
    expect(third.getContext().url).toContain('thread=t1');
    expect(first.getContext().url).not.toContain('thread=t1');
    expect(second.getContext().url).not.toContain('thread=t1');

    // Back and forward reach it too.
    history.replaceState(null, '', '/workspaces/w-1/docs/saltmarsh-brief?thread=t2');
    expect(third.getContext().url).toContain('thread=t2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(second.getContext().url).not.toContain('thread=t2');
  });

  it('a widget mounted after every earlier one left still hears route changes', () => {
    const el = moveTo('harborlight-notes');
    history.pushState(null, '', '/workspaces/w-1/docs/harborlight-notes?thread=t3');
    expect(el.getContext().url).toContain('thread=t3');
  });
});
