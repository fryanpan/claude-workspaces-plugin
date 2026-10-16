/**
 * A reply line says where the comment came from and what it answers.
 *
 * An agent was handed `[replied] <owner>: Go ahead` and nothing else, so
 * "go ahead" with what was a guess. The server now stamps the doc's name
 * (`docTitle` — a task's title on the task's own comments) and the comment
 * the reply follows (`inReplyTo`); the line quotes both. A server older than
 * the stamp sends neither, and the line must read exactly as it did.
 *
 * All fixtures synthetic. Nothing here opens a socket or touches a real
 * server.
 */
import { describe, expect, it } from 'vitest';
import { harness, only } from './channel-harness.ts';

const ASK = 'Should I delete the old Harborlight fixtures?';

describe('a reply line carries its context', () => {
  it('names the doc and quotes the comment it answers', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      commentTrust: 'owner',
      docId: 'riverbend-plan',
      threadId: 't1',
      docTitle: 'Riverbend rollout plan',
      inReplyTo: { author: 'Builder', trust: 'owner', text: ASK },
      comment: { author: { name: 'Alice' }, text: 'Go ahead' },
      thread: { anchor: { snippet: { text: 'the fixtures section' } } },
    });
    const f = only(frames);
    expect(f.content).toBe(`[replied] Alice on "Riverbend rollout plan" — to "${ASK}": Go ahead`);
    expect(f.meta).toMatchObject({
      doc_title: 'Riverbend rollout plan',
      in_reply_to: ASK,
      in_reply_to_author: 'Builder',
    });
  });

  it("names the task on a reply to the task's own comments, where there is no anchor", async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      commentTrust: 'owner',
      docId: 'task:t-42',
      threadId: 't2',
      docTitle: 'Fix the flaky upload test',
      inReplyTo: { author: 'Builder', trust: 'owner', text: ASK },
      comment: { author: { name: 'Alice' }, text: 'Go ahead' },
      thread: { anchor: { kind: 'subject' } },
    });
    const f = only(frames);
    expect(f.content).toBe(
      `[replied] Alice on "Fix the flaky upload test" — to "${ASK}": Go ahead`,
    );
    expect(f.meta.anchor_text).toBe('');
  });

  it('quotes a long parent on one line, cut to about a hundred characters', async () => {
    const { frames, messages } = harness();
    const long = `First line of the question\n\n${'and then a great deal more detail '.repeat(10)}`;
    await messages.emitChannelMessage('thread.replied', {
      commentTrust: 'owner',
      docId: 'd',
      threadId: 't3',
      docTitle: 'Saltmarsh notes',
      inReplyTo: { author: 'Builder', trust: 'owner', text: long },
      comment: { author: { name: 'Bob' }, text: 'Yes' },
    });
    const content = only(frames).content;
    const quoted = /— to "([^"]*)": Yes$/.exec(content)?.[1] ?? '';
    expect(quoted.startsWith('First line of the question and then')).toBe(true);
    expect(quoted).toHaveLength(100);
    expect(quoted.endsWith('…')).toBe(true);
    expect(content).not.toContain('\n');
  });

  it('a new thread gets the title and no reply clause', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      commentTrust: 'owner',
      docId: 'task:t-43',
      threadId: 't4',
      docTitle: 'Rename the Riverbend bucket',
      thread: { comments: [{ author: { name: 'Alice' }, text: 'Which region?' }] },
    });
    expect(only(frames).content).toBe(
      '[created] Alice on "Rename the Riverbend bucket": Which region?',
    );
  });

  it('an older server that sends neither field produces the line it always did', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      commentTrust: 'owner',
      docId: 'task:t-42',
      threadId: 't5',
      comment: { author: { name: 'Alice' }, text: 'Go ahead' },
      thread: { anchor: { kind: 'subject' } },
    });
    const f = only(frames);
    expect(f.content).toBe('[replied] Alice: Go ahead');
    expect(f.meta).not.toHaveProperty('doc_title');
    expect(f.meta).not.toHaveProperty('in_reply_to');
  });
});
