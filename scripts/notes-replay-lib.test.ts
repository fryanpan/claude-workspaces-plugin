/**
 * The replay plan, its clock and the goal verdicts, on invented meetings.
 * All speech here is made up. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { GOAL, ideaWindows, noteShape, scoreGoals } from './notes-replay-goals.ts';
import {
  ReplayClock,
  type ReplayEvent,
  SpendMeter,
  driveReplay,
  legFrames,
  parseTranscript,
  planMeetings,
} from './notes-replay-lib.ts';

const T0 = 1_000_000;

describe('parseTranscript', () => {
  it('keeps one row per turn, the revision text and the first settle time', () => {
    const rows = parseTranscript(
      [
        JSON.stringify({ turn: 0, text: 'Harborlight opens on Monday', ts: T0, speaker: 'A' }),
        JSON.stringify({ turn: 1, text: 'Riverbend waits', ts: T0 + 500 }),
        JSON.stringify({ turn: 0, text: 'Harborlight opens on Tuesday', ts: T0 + 900 }),
        JSON.stringify({ turn: 2, text: '   ', ts: T0 + 1000 }),
        'not json',
      ].join('\n'),
    );
    expect(rows.map((r) => [r.turn, r.text, r.ts])).toEqual([
      [0, 'Harborlight opens on Tuesday', T0],
      [1, 'Riverbend waits', T0 + 500],
    ]);
  });
});

describe('planMeetings', () => {
  const index = [
    { meetingId: 'm1', startedAt: T0 },
    { meetingId: 'm1', speakers: { 'remote:A': 'Alice' } },
    { meetingId: 'm1', endedAt: T0 + 10_000, turns: 2 },
    { meetingId: 'm1', resumedAt: T0 + 12_000 },
    { meetingId: 'm1', gapStream: 'mic', gapFrom: T0 + 10_000 },
    { meetingId: 'm1', speakers: { 'remote:B': 'Bob' } },
    { meetingId: 'm1', endedAt: T0 + 30_000, turns: 3 },
    { meetingId: 'm-empty', startedAt: T0 + 40_000 },
  ];
  const rows = [
    { turn: 0, text: 'Saltmarsh first', ts: T0 + 1_000 },
    { turn: 1, text: 'Saltmarsh second', ts: T0 + 5_000 },
    { turn: 2, text: 'after the reconnect', ts: T0 + 20_000 },
  ];
  const transcripts = new Map([
    ['m1', rows],
    ['m-empty', []],
  ]);

  it('cuts a meeting at every resume and files each turn under its leg', () => {
    const [m, ...rest] = planMeetings(index, transcripts);
    expect(rest).toEqual([]);
    expect(m?.legs.map((l) => [l.startAt, l.endAt, l.turns.map((t) => t.turn)])).toEqual([
      [T0, T0 + 10_000, [0, 1]],
      [T0 + 12_000, T0 + 30_000, [2]],
    ]);
    expect(m?.legs.map((l) => l.names)).toEqual([{ 'remote:A': 'Alice' }, { 'remote:B': 'Bob' }]);
    expect(m?.legs[1]?.openLines.map((l) => Object.keys(l)[1])).toEqual([
      'resumedAt',
      'gapStream',
      'speakers',
    ]);
  });

  it('runs the whole meeting as one leg when asked', () => {
    const [m] = planMeetings(index, transcripts, { oneLeg: true });
    expect(m?.legs).toHaveLength(1);
    expect(m?.legs[0]?.turns).toHaveLength(3);
    expect(m?.legs[0]?.endAt).toBe(T0 + 30_000);
  });
});

describe('legFrames', () => {
  it('models partials of the real words ahead of each settled turn', () => {
    const frames = legFrames([{ turn: 4, text: 'one two three four', ts: T0 + 2_000 }], T0, 200);
    const finals = frames.filter((f) => f.frame.final);
    expect(finals).toEqual([
      {
        at: T0 + 2_000,
        spokenAt: T0 + 1_800,
        frame: { turn: 4, text: 'one two three four', final: true },
      },
    ]);
    const partials = frames.filter((f) => !f.frame.final);
    expect(partials.length).toBe(4);
    expect(partials.every((f) => f.at > T0 && f.at < T0 + 1_800)).toBe(true);
    expect(partials.every((f) => 'one two three four'.startsWith(f.frame.text))).toBe(true);
    expect(frames.map((f) => f.at)).toEqual([...frames.map((f) => f.at)].sort((a, b) => a - b));
  });
});

describe('ReplayClock and driveReplay', () => {
  it('jumps while idle, and delivers a frame due mid-call while the call runs', async () => {
    const clock = new ReplayClock(T0);
    const seen: Array<{ what: string; at: number; busy: boolean }> = [];
    const note = (what: string): void => {
      seen.push({ what, at: clock.now(), busy: clock.busy });
    };
    clock.set(() => note('timer'), 4_000);
    const events: ReplayEvent[] = [
      {
        at: T0 + 1_000,
        run: () => {
          note('call starts');
          clock.begin();
          // The model answers fifty real milliseconds later.
          setTimeout(() => clock.finish(), 50);
        },
      },
      { at: T0 + 1_020, run: () => note('frame') },
    ];
    await driveReplay(clock, events);
    expect(seen.map((s) => s.what)).toEqual(['call starts', 'frame', 'timer']);
    // The idle stretch before the call cost nothing: it began exactly on time.
    expect(seen[0]).toMatchObject({ at: T0 + 1_000, busy: false });
    // The frame arrived DURING the call, on the call's own clock.
    expect(seen[1]?.busy).toBe(true);
    expect(seen[1]?.at).toBeGreaterThanOrEqual(T0 + 1_020);
    // And the timer, after the call, fired on its deadline.
    expect(seen[2]).toMatchObject({ at: T0 + 4_000, busy: false });
  });

  it('puts the time a call took on the timeline', async () => {
    let wall = 0;
    const clock = new ReplayClock(T0, () => wall);
    clock.begin();
    wall += 2_500;
    clock.finish();
    expect(clock.now()).toBe(T0 + 2_500);
  });

  it('leaves a timer past `until` unrun once the events are spent', async () => {
    const clock = new ReplayClock(T0, () => 0);
    let fired = false;
    clock.set(() => {
      fired = true;
    }, 60_000);
    await driveReplay(clock, [], T0 + 1_000);
    expect(fired).toBe(false);
  });
});

describe('scoreGoals', () => {
  const clean = {
    duplicateBulletLines: 0,
    duplicateHeadings: 0,
    ideas: { judged: 100, lost: 4 },
    waitsMs: [3_000, 6_000, 9_000, 10_000],
    unknownSpeakers: 0,
    reportedKinds: [] as string[],
  };

  it('passes a meeting that meets every bar, and needs no report', () => {
    const g = scoreGoals(clean);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.pass]))).toEqual({
      repeats: true,
      lostIdeas: true,
      latency: true,
      speakers: true,
      reported: true,
    });
  });

  it('fails each bar at its own edge', () => {
    const g = scoreGoals({
      ...clean,
      duplicateHeadings: 1,
      ideas: { judged: 100, lost: 11 },
      waitsMs: [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_001],
      unknownSpeakers: 1,
    });
    expect(g.repeats?.pass).toBe(false);
    expect(g.lostIdeas).toMatchObject({ pass: false, defect: true, lostShare: 0.11 });
    expect(g.latency).toMatchObject({ pass: false, lateOver10s: 1, lateShare: 0.1 });
    expect(g.speakers?.pass).toBe(false);
  });

  it('scores paraphrased repeats only when they were judged, and leaves them out of the report goal', () => {
    expect(scoreGoals(clean).paraphrases).toBeUndefined();
    expect(scoreGoals({ ...clean, paraphrasedRepeats: 0 }).paraphrases?.pass).toBe(true);
    const g = scoreGoals({ ...clean, paraphrasedRepeats: 3 });
    expect(g.paraphrases).toMatchObject({ pass: false, paraphrasedRepeats: 3 });
    // No product flag can name a paraphrase, so a miss here is not a silent one.
    expect(g.reported).toMatchObject({ pass: true, missed: [] });
    expect(scoreGoals({ ...clean, paraphrasedRepeats: null }).paraphrases).toMatchObject({
      pass: false,
      paraphrasedRepeats: null,
    });
  });

  it('counts a missed goal as reported only when a filed flag names it', () => {
    const g = scoreGoals({
      ...clean,
      duplicateBulletLines: 2,
      waitsMs: [GOAL.lateMs + 1],
      reportedKinds: ['duplicate-bullets'],
    });
    expect(g.reported).toMatchObject({
      pass: false,
      missed: ['repeats', 'latency'],
      unreported: ['latency'],
    });
  });

  it('never passes lost ideas or latency on no evidence', () => {
    const g = scoreGoals({ ...clean, ideas: null, waitsMs: [] });
    expect(g.lostIdeas?.pass).toBe(false);
    expect(g.latency?.pass).toBe(false);
  });
});

describe('ideaWindows', () => {
  it('closes a window at a long silence or at the size bound', () => {
    const t = (turn: number, ts: number, text = 'Riverbend') => ({ turn, ts, text });
    const w = ideaWindows([t(0, 0), t(1, 1_000), t(2, 60_000), t(3, 61_000, 'x'.repeat(50))], 40);
    expect(w.map((x) => x.map((r) => r.turn))).toEqual([[0, 1], [2], [3]]);
  });
});

describe('SpendMeter', () => {
  it('books each reply and refuses to send past the cap', async () => {
    const meter = new SpendMeter(0.002);
    let sent = 0;
    const reply = async (): Promise<Response> => {
      sent++;
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 1_000, output_tokens: 200 },
        }),
      );
    };
    const f = meter.fetch(reply as unknown as typeof fetch);
    await f('https://example.invalid');
    expect(meter.spentUsd).toBeCloseTo(0.002, 6);
    await expect(f('https://example.invalid')).rejects.toThrow('spend cap');
    expect(sent).toBe(1);
  });
});

describe('noteShape', () => {
  it('counts each note-taking criterion from the free checks', () => {
    const notes = [
      '### Harborlight launch',
      '- **Decision:** we agreed to ship the beta on Friday',
      '- one',
      '- two',
      '- three',
      '- four',
      '### Riverbend pricing',
      '- **Question:** does the discount apply to renewals, or only to new accounts signed this quarter and the next one after that?',
      '### Harborlight launch',
      '- Alice said the export button sits under the settings menu today',
      '- [@Bob](speaker:B) **Question:** who owns it?',
      '### Saltmarsh',
    ].join('\n');
    const transcript = 'Alice said the export button sits under the settings menu today.';
    expect(noteShape(notes, transcript)).toEqual({
      topics: 4,
      longFlatRuns: 1,
      topicsWithLongRun: 1,
      topicsWithLongRunShare: 0.25,
      overlongBullets: 1,
      duplicateTopics: 1,
      emptyHeadings: 1,
      decisionsWithoutSpeaker: 2,
      verbatimBullets: 1,
      decisionPrefixes: 1,
      questionPrefixes: 2,
    });
  });
});
