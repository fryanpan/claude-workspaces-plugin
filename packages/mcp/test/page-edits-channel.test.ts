/**
 * A send from the widget's edit mode, as the agent reads it.
 *
 * The comment's words are the server's one-line-an-edit summary, which
 * quotes each side short. The line tells the agent what to do with the edits
 * and the meta carries each one whole, so a long paragraph retyped on the
 * page reaches the agent in full. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { harness, only } from './channel-harness.ts';

const edit = { selector: 'main h1', before: 'Harborlight Projects', after: 'Harborlight Works' };

describe('a page edit on the channel', () => {
  it('carries each edit whole and says how to apply them', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'mock',
      threadId: 't1',
      thread: {
        anchor: { kind: 'element', snippet: { text: 'Harborlight Projects' } },
        comments: [
          {
            author: { name: 'Alice' },
            text: '1 text edit on this page:\n- main h1: "Harborlight Projects" → "Harborlight Works"',
            pageEdits: [{ ...edit, anchor: { kind: 'element' } }],
          },
        ],
      },
    });
    const f = only(frames);
    expect(JSON.parse(String(f.meta.page_edits))).toEqual([edit]);
    expect(f.content).toContain('→ "Harborlight Works"');
    expect(f.content).toContain('resolve_thread');
  });

  it('leaves an ordinary comment exactly as it was', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'mock',
      threadId: 't2',
      thread: { comments: [{ author: { name: 'Alice' }, text: 'tighten this' }] },
    });
    const f = only(frames);
    expect(f.content).toBe('[created] Alice: tighten this');
    expect('page_edits' in f.meta).toBe(false);
  });
});
