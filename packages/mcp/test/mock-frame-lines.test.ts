/**
 * A write relayed out of a served mock's sandboxed frame says so in every line
 * an agent reads about it — and a write from anywhere else says nothing new.
 *
 * The server records `via: 'mock-frame'` on the comment, the status change or
 * the ticket answer (`server/src/mockup-frame.ts`). A mock's own script can
 * make those calls, so the agent must be able to tell such words from words
 * typed on the board. Each case renders the same frame with and without the
 * mark.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';
import { decisionAnsweredLine } from '../src/decision-line.ts';
import { reviewAnsweredLine } from '../src/nudge-line.ts';

const NOTE = '(sent from inside the mock page)';

async function render(event: string, payload: unknown): Promise<string> {
  const frames: ChannelNotification['params'][] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      frames.push(n.params);
    },
    http: async () => ({}),
    authorId: 'agent-riverbend',
    now: () => Date.UTC(2026, 8, 13),
  });
  await messages.emitChannelMessage(event, payload);
  expect(frames).toHaveLength(1);
  return frames[0]?.content ?? '';
}

describe('a relayed write is named as sent from inside the mock', () => {
  it('on a reply', async () => {
    const reply = (via?: string) => ({
      docId: 'price-board',
      threadId: 't1',
      comment: { author: { name: 'Reviewer' }, text: 'too small', ts: 1, ...(via ? { via } : {}) },
    });
    expect(await render('thread.replied', reply('mock-frame'))).toBe(
      `[replied] Reviewer ${NOTE}: too small`,
    );
    expect(await render('thread.replied', reply())).toBe('[replied] Reviewer: too small');
    // Only the one value is a mark.
    expect(await render('thread.replied', reply('elsewhere'))).toBe(
      '[replied] Reviewer: too small',
    );
  });

  it('on a new thread, read off its comment', async () => {
    const created = (via?: string) => ({
      docId: 'price-board',
      threadId: 't2',
      thread: {
        comments: [{ author: { name: 'Reviewer' }, text: 'move it up', ...(via ? { via } : {}) }],
      },
    });
    expect(await render('thread.created', created('mock-frame'))).toBe(
      `[created] Reviewer ${NOTE}: move it up`,
    );
    expect(await render('thread.created', created())).toBe('[created] Reviewer: move it up');
  });

  it('on a resolve, read off the frame', async () => {
    const resolved = (via?: string) => ({
      docId: 'price-board',
      threadId: 't3',
      actor: { name: 'Reviewer' },
      ...(via ? { via } : {}),
    });
    expect(await render('thread.resolved', resolved('mock-frame'))).toBe(
      `[resolved] by Reviewer ${NOTE} — thread t3`,
    );
    expect(await render('thread.resolved', resolved())).toBe('[resolved] by Reviewer — thread t3');
  });

  it('on a ticket answer, both to the task watcher and to the lead', () => {
    const answer = { taskId: 't-price', answer: 'Readable.', actor: { name: 'Reviewer' } };
    expect(decisionAnsweredLine({ ...answer, via: 'mock-frame' })).toBe(
      `[decision.answered] t-price by Reviewer ${NOTE}: "Readable."`,
    );
    expect(decisionAnsweredLine(answer)).toBe(
      '[decision.answered] t-price by Reviewer: "Readable."',
    );

    const nudge = { taskId: 't-price', title: 'Price board', headline: 'Readable?' };
    expect(reviewAnsweredLine({ ...nudge, via: 'mock-frame' })).toContain(
      `has an answer ${NOTE} —`,
    );
    expect(reviewAnsweredLine(nudge)).not.toContain(NOTE);
  });
});
