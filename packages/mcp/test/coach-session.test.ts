/**
 * The coach session's half: each frame reads as one line naming what the
 * owner did, and `coach_moment` posts a moment, handing back the server's
 * refusal as an answer the session can read.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';
import { coachLine } from '../src/coach-line.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

describe('coachLine', () => {
  it('names what the owner did, where, and carries their words', () => {
    const line =
      coachLine(
        'coach.event',
        {
          at: Date.UTC(2026, 9, 7, 17, 5),
          kind: 'wrote',
          boardId: 'w-1',
          board: 'Harborlight',
          docId: 'd-1',
          doc: 'Launch post',
          heading: 'Pricing',
          text: 'We should build the importer first.',
        },
        'America/Los_Angeles',
      ) ?? '';
    expect(line).toBe(
      '[coach.event 10:05] The owner wrote, in "Launch post" on board "Harborlight", under "Pricing".\nWe should build the importer first.',
    );
    expect(coachLine('coach.event', { kind: 'left', boardId: 'w-1', board: 'Riverbend' })).toBe(
      '[coach.event] The owner left the page of board "Riverbend".',
    );
  });

  it('reads a digest as one line per stay or thing done, with the words he wrote', () => {
    const t = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
    const line = coachLine(
      'coach.digest',
      {
        from: t(17, 0),
        to: t(17, 15),
        items: [
          {
            kind: 'view',
            at: t(17, 0),
            minutes: 12,
            boardId: 'w-1',
            board: 'Harborlight',
            docId: 'd-2',
            doc: 'Button hover mock',
            headings: ['Hover', 'Focus'],
          },
          {
            kind: 'comment',
            at: t(17, 12),
            boardId: 'w-1',
            board: 'Harborlight',
            docId: 'd-2',
            doc: 'Button hover mock',
            text: 'Softer shadow?\nAnd a 2px lift.',
          },
          { kind: 'left', at: t(17, 14), boardId: 'w-1', board: 'Harborlight' },
        ],
      },
      'America/Los_Angeles',
    );
    expect(line).toBe(
      [
        '[coach.digest 10:00–10:15] What the owner did:',
        '- 10:00, 12 min: read "Button hover mock" on board "Harborlight" ("Hover", "Focus")',
        '- 10:12: commented on "Button hover mock" on board "Harborlight"',
        '  Softer shadow?',
        '  And a 2px lift.',
        '- 10:14: left the page of board "Harborlight"',
      ].join('\n'),
    );
    expect(coachLine('coach.digest', { items: [{ kind: 'danced', boardId: 'w-1' }] })).toBeNull();
  });

  it("ends a digest with this week's plan goals in plan order, or says there is none", () => {
    const items = [{ kind: 'left', at: Date.UTC(2026, 9, 7, 17, 0), boardId: 'w-1' }];
    const line = coachLine(
      'coach.digest',
      {
        items,
        plan: {
          set: '2026-10-05',
          goals: [
            { id: 'g-harbor', title: 'Harborlight ships the berth map' },
            { id: 'g-river', title: 'Riverbend answers every ask' },
          ],
        },
      },
      'UTC',
    );
    expect(line?.split('\n').slice(-3)).toEqual([
      "This week's plan (set 2026-10-05), first to last:",
      '1. Harborlight ships the berth map (g-harbor)',
      '2. Riverbend answers every ask (g-river)',
    ]);
    const stale = coachLine(
      'coach.digest',
      {
        items,
        plan: { set: '2026-09-20', stale: true, goals: [{ id: 'g-salt', title: 'Saltmarsh' }] },
      },
      'UTC',
    );
    expect(stale?.split('\n').slice(-2)).toEqual([
      "This week's plan (set 2026-09-20; plan may be stale), first to last:",
      '1. Saltmarsh (g-salt)',
    ]);
    const none = coachLine('coach.digest', { items, plan: 'no current week plan' }, 'UTC');
    expect(none?.split('\n').at(-1)).toBe("This week's plan: no current week plan.");
    const older = coachLine('coach.digest', { items }, 'UTC');
    expect(older).not.toContain('plan');
  });

  it('lists his Claude Code time per session before the plan, and says once what is not counted', () => {
    const note = 'Claude Code sessions not attached to a board are not counted.';
    const line = coachLine(
      'coach.digest',
      {
        items: [],
        sessions: [
          {
            boardId: 'w-1',
            board: 'Harborlight',
            repo: 'harborlight-app',
            minutes: 10,
            prompts: 1,
            turns: 3,
          },
          { boardId: 'w-2', repo: 'saltmarsh', minutes: 1, prompts: 1, turns: 0 },
        ],
        sessionsNote: note,
        plan: 'no current week plan',
      },
      'UTC',
    );
    expect(line?.split('\n').slice(1)).toEqual([
      'Claude Code sessions (active minutes):',
      '- harborlight-app, on board "Harborlight": 10 min, 1 typed prompt, 3 turn ends',
      '- saltmarsh, on board "w-2": 1 min, 1 typed prompt, 0 turn ends',
      note,
      "This week's plan: no current week plan.",
    ]);
    const none = coachLine(
      'coach.digest',
      { items: [{ kind: 'left', boardId: 'w-1' }], sessions: [], sessionsNote: note },
      'UTC',
    );
    expect(none?.split('\n').slice(-2)).toEqual(['Claude Code sessions: none counted.', note]);
    expect(coachLine('coach.digest', { items: [{ kind: 'left', boardId: 'w-1' }] })).not.toContain(
      'Claude Code',
    );
  });

  it('says under each session what he asked and what it answered, and how long the session was away', () => {
    const line = coachLine(
      'coach.digest',
      {
        from: Date.UTC(2026, 9, 16, 9, 0),
        to: Date.UTC(2026, 9, 16, 10, 0),
        windows: 4,
        dropped: 2,
        items: [],
        sessions: [
          {
            boardId: 'w-1',
            board: 'Riverbend',
            repo: 'riverbend',
            minutes: 6,
            prompts: 1,
            turns: 1,
            activity: [
              {
                at: Date.UTC(2026, 9, 16, 9, 5),
                kind: 'prompt',
                summary: 'Asked for a tide table',
              },
              { at: Date.UTC(2026, 9, 16, 9, 11), kind: 'turn', summary: 'Drew the tide table' },
            ],
          },
        ],
      },
      'UTC',
    );
    expect(line?.split('\n').slice(0, 5)).toEqual([
      '[coach.digest 09:00–10:00] What the owner did (held while you were away: 4 windows, 2 older ones dropped):',
      'Claude Code sessions (active minutes):',
      '- riverbend, on board "Riverbend": 6 min, 1 typed prompt, 1 turn end',
      '  - 09:05 he asked: Asked for a tide table',
      '  - 09:11 session: Drew the tide table',
    ]);
  });

  it('gives each line its words in full below it, once', () => {
    const prompt = `${'Chart the Riverbend tides '.repeat(36)}\nand the berths.`;
    const line = coachLine(
      'coach.digest',
      {
        items: [],
        sessions: [
          {
            boardId: 'w-1',
            repo: 'riverbend',
            activity: [
              { at: Date.UTC(2026, 9, 16, 9, 5), kind: 'prompt', summary: 'Asked', text: prompt },
              { at: Date.UTC(2026, 9, 16, 9, 6), kind: 'turn', summary: 'Done.', text: 'Done.' },
            ],
          },
        ],
      },
      'UTC',
    );
    const [first, second] = prompt.split('\n');
    expect(line?.split('\n').slice(3, 7)).toEqual([
      '  - 09:05 he asked: Asked',
      `    ${first}`,
      `    ${second}`,
      '  - 09:06 session: Done.',
    ]);
  });

  it('reads an answer, with what a thumbs down wrote, and a preference as things to remember', () => {
    const moment = {
      momentId: 'cm-aaaaaaaaaaaa',
      goal: 'Ask why first',
      line: "Hi, I'm noticing you're designing the fix. Why first?",
    };
    expect(coachLine('coach.answer', { ...moment, answer: 'up' })).toContain(
      'The owner answered thumbs up: it helped. Your moment cm-aaaaaaaaaaaa',
    );
    expect(
      coachLine('coach.answer', { ...moment, answer: 'down', text: 'Harborlight asked for it' }),
    ).toContain(
      'The owner answered thumbs down: it did not help. They wrote: "Harborlight asked for it". Your moment',
    );
    expect(coachLine('coach.preference', { readiness: 'less' })).toContain('less readily');
  });

  it('reads the morning wake-up as the day, and where to look', async () => {
    const morning = { day: '2026-10-12', weekday: 'Monday' };
    const line =
      '[coach.morning Monday 2026-10-12] It is morning for the owner. Check "This week\'s nudges" in your memory doc.';
    expect(coachLine('coach.morning', morning)).toBe(line);
    expect(coachLine('coach.morning', { day: '2026-10-12' })).toBeNull();
    const frames: ChannelNotification['params'][] = [];
    const messages = createChannelMessages({
      notify: async (n) => {
        frames.push(n.params);
      },
      http: async () => ({}),
      authorId: 'agent-coach',
      now: () => Date.UTC(2026, 9, 12, 15),
    });
    await messages.emitBoardChannelMessage('coach.morning', { ...morning, workspaceId: 'w-coach' });
    expect(frames.map((f) => f.content)).toEqual([line]);
  });

  it('says nothing for a frame it cannot read', () => {
    expect(coachLine('coach.event', { kind: 'danced', boardId: 'w-1' })).toBeNull();
    expect(coachLine('coach.answer', { answer: 'thanks' })).toBeNull();
    expect(coachLine('coach.preference', { readiness: 'loud' })).toBeNull();
  });
});

function ctxFor(answer: (path: string) => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer(path);
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  };
  return { calls, ctx: ctx as never };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

const MOMENT = {
  goal: 1,
  matched: 'I start on a solution',
  observed: 'Designing the importer before saying why',
  line: "Hi, I'm noticing you're designing the importer. What is it for?",
};

describe('coach_moment', () => {
  it('posts the moment and returns its id', async () => {
    const { calls, ctx } = ctxFor(() => ({ id: 'cm-aaaaaaaaaaaa' }));
    const r = await handleWorkspaceTool('coach_moment', MOMENT, ctx);
    expect(calls).toEqual([['POST', '/coach/moments', MOMENT]]);
    expect(JSON.parse(text(r))).toEqual({ raised: true, id: 'cm-aaaaaaaaaaaa' });
  });

  it('hands back a refusal with its reason, and throws anything else', async () => {
    const refused = ctxFor(() => {
      throw new Error(
        'POST /coach/moments → 409: {"error":"moment-open","message":"A moment is already on his page."}',
      );
    });
    const r = await handleWorkspaceTool('coach_moment', MOMENT, refused.ctx);
    expect(JSON.parse(text(r))).toMatchObject({ raised: false, reason: 'moment-open' });
    const broken = ctxFor(() => {
      throw new Error('POST /coach/moments → 500: boom');
    });
    await expect(handleWorkspaceTool('coach_moment', MOMENT, broken.ctx)).rejects.toThrow('500');
  });
});
