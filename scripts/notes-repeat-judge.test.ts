/**
 * The paraphrased-repeat count, on invented notes. All text here is made up.
 * The repo is public.
 */
import { describe, expect, it } from 'vitest';
import {
  type RepeatCall,
  judgeRepeats,
  modelCall,
  noteSections,
  parseRepeatAnswer,
  repeatBatches,
} from './notes-repeat-judge.ts';

const NOTES = [
  '## Harborlight launch',
  '',
  '- [@Alice](speaker:remote:A?t=1) says Harborlight opens on Monday',
  '  - [@Bob](speaker:remote:B?t=2) asks who signs off',
  '- Harborlight launches Monday',
  '',
  '### Riverbend',
  '',
  '- Riverbend waits on the export',
  '',
  '## Saltmarsh',
  '',
  '- Saltmarsh is done',
  '- Saltmarsh finished',
  '- Saltmarsh has no owner yet',
].join('\n');

describe('noteSections', () => {
  it('cuts at every heading, keeps nested bullets and keeps the speaker name only', () => {
    expect(noteSections(NOTES)).toEqual([
      {
        heading: 'Harborlight launch',
        notes: [
          'Alice says Harborlight opens on Monday',
          'Bob asks who signs off',
          'Harborlight launches Monday',
        ],
      },
      { heading: 'Riverbend', notes: ['Riverbend waits on the export'] },
      {
        heading: 'Saltmarsh',
        notes: ['Saltmarsh is done', 'Saltmarsh finished', 'Saltmarsh has no owner yet'],
      },
    ]);
  });
});

describe('repeatBatches', () => {
  it('drops a section with one note and never splits a section', () => {
    const batches = repeatBatches(noteSections(NOTES), 4);
    expect(batches.map((b) => b.map((s) => s.heading))).toEqual([
      ['Harborlight launch'],
      ['Saltmarsh'],
    ]);
  });
});

describe('parseRepeatAnswer', () => {
  const batch = repeatBatches(noteSections(NOTES), 100)[0] ?? [];
  it('counts each restating note once and refuses an index the batch never had', () => {
    expect(
      parseRepeatAnswer(
        {
          repeats: [
            { section: 1, note: 3, restates: 1 },
            { section: 2, note: 2, restates: 1 },
            { section: 2, note: 2, restates: 1 },
          ],
        },
        batch,
      ),
    ).toEqual([
      { section: 0, note: 2, restates: 0 },
      { section: 1, note: 1, restates: 0 },
    ]);
    expect(
      parseRepeatAnswer({ repeats: [{ section: 3, note: 2, restates: 1 }] }, batch),
    ).toBeNull();
    expect(
      parseRepeatAnswer({ repeats: [{ section: 1, note: 1, restates: 1 }] }, batch),
    ).toBeNull();
    expect(parseRepeatAnswer({}, batch)).toBeNull();
  });
  it('reads restates 0 as a note that says something new', () => {
    expect(
      parseRepeatAnswer(
        {
          repeats: [
            { section: 1, note: 2, restates: 0 },
            { section: 1, note: 3, restates: 0 },
            { section: 2, note: 2, restates: 1 },
          ],
        },
        batch,
      ),
    ).toEqual([{ section: 1, note: 1, restates: 0 }]);
  });
  it('reads a list the judge sent as a JSON string, the way a model sometimes nests it', () => {
    const rows = [{ section: 1, note: 3, restates: 1 }];
    const want = [{ section: 0, note: 2, restates: 0 }];
    expect(parseRepeatAnswer({ repeats: JSON.stringify(rows) }, batch)).toEqual(want);
    expect(parseRepeatAnswer({ repeats: JSON.stringify({ repeats: rows }) }, batch)).toEqual(want);
    expect(parseRepeatAnswer({ repeats: 'not json' }, batch)).toBeNull();
  });
  it('reads "restates" as the EARLIER note, whichever order the judge wrote them', () => {
    expect(parseRepeatAnswer({ repeats: [{ section: 2, note: 1, restates: 2 }] }, batch)).toEqual([
      { section: 1, note: 1, restates: 0 },
    ]);
  });
});

describe('judgeRepeats', () => {
  it('counts a proposal only when the checker agrees, and an unreadable batch as unjudged', async () => {
    const proposed: string[] = [];
    const propose: RepeatCall = async (user) => {
      proposed.push(user);
      if (user.includes('Saltmarsh')) return null;
      return {
        repeats: [
          { section: 1, note: 2, restates: 1 },
          { section: 1, note: 3, restates: 1 },
        ],
      };
    };
    const checked: string[] = [];
    const check: RepeatCall = async (user) => {
      checked.push(user);
      return { repeat: user.endsWith('Harborlight launches Monday') };
    };
    const out = await judgeRepeats(NOTES, propose, check, 4);
    // Each batch is asked twice before it is given up on.
    expect(proposed.length).toBe(3);
    // The checker sees the notes above the proposal and nothing below it.
    expect(checked[0]).toContain('1. Alice says Harborlight opens on Monday');
    expect(checked[0]).not.toContain('Harborlight launches Monday');
    expect(out).toEqual({
      notes: 7,
      judgedNotes: 4,
      repeats: 1,
      unchecked: 0,
      pairs: [{ heading: 'Harborlight launch', note: 2, restates: 0 }],
    });
  });

  it('counts a proposal the checker will not answer as unchecked, never as a repeat', async () => {
    const propose: RepeatCall = async () => ({ repeats: [{ section: 1, note: 2, restates: 1 }] });
    let asks = 0;
    const out = await judgeRepeats(NOTES, propose, async () => {
      asks++;
      return { repeat: 'yes' };
    });
    expect(asks).toBe(2);
    expect(out).toMatchObject({ repeats: 0, unchecked: 1 });
  });
});

describe('modelCall', () => {
  it('offers the tool unforced, books the usage and reads the tool call', async () => {
    let sent: Record<string, unknown> = {};
    const booked: string[] = [];
    const call = modelCall({
      key: { kind: 'key', value: 'test-not-a-real-key' },
      model: 'claude-sonnet-5-5',
      system: 'sys',
      tool: { name: 'record_verdict' },
      maxTokens: 100,
      book: (model) => booked.push(model),
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'tool_use', name: 'record_verdict', input: { repeat: true } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(await call('the notes')).toEqual({ repeat: true });
    expect(sent.tool_choice).toEqual({ type: 'auto' });
    expect(booked).toEqual(['claude-sonnet-5-5']);
  });
});
