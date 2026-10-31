/**
 * The spoken reply's answer: the router's words cut into a spoken part and a
 * written part, the wake word off the front, and the one question it adds —
 * "which goal?" — asked once and answered by ordinal or by name.
 */
import { describe, expect, it } from 'bun:test';
import {
  SpokenAnswerer,
  type SpokenBoard,
  goalAsk,
  namedGoalAsk,
} from '../src/spoken-reply/answer.ts';
import { sentences, shapeReply, stripWake } from '../src/spoken-reply/reply-shape.ts';
import type { VoiceHandleResult } from '../src/voice.ts';

const ACTOR = { id: 'known-alice', name: 'Alice', kind: 'known' };

function board(goals: Array<{ id: string; title: string }>): SpokenBoard & {
  heard: string[];
  goalAsked: string[];
} {
  const heard: string[] = [];
  const goalAsked: string[] = [];
  return {
    heard,
    goalAsked,
    async handle(_ws, req): Promise<VoiceHandleResult> {
      heard.push(req.transcript);
      return {
        ok: true,
        route: 'fast-path',
        ack: `Heard: "${req.transcript}". Harborlight: 4 open — 2 in progress, 2 to do, 1 done. In progress: “Riverbend import”. Waiting on you: 1 — “pick a name” on “Saltmarsh”. Done recently: “Bob’s fix”.`,
      };
    },
    goalStatus(_ws, goalId) {
      goalAsked.push(goalId);
      return { route: 'fast-path', ack: `Goal ${goalId}: 2 open. In progress: “x”.` };
    },
    goals: () => goals,
  };
}

describe('stripWake', () => {
  it('takes the wake word off the front', () => {
    expect(stripWake('Claude, give me a status update')).toBe('give me a status update');
    expect(stripWake('hey Claude. where are we')).toBe('where are we');
    expect(stripWake('okay claude catch me up')).toBe('catch me up');
  });
  it('leaves a request without one alone, and never empties it', () => {
    expect(stripWake('give me a status update')).toBe('give me a status update');
    expect(stripWake('Claude')).toBe('Claude');
  });
});

describe('shapeReply', () => {
  it('speaks the headline and what is waiting on you, and writes the rest', () => {
    const r = shapeReply(
      'Heard: "status". Harborlight: 4 open. In progress: “a”. Waiting on you: 1 — “b”. Done recently: “c”.',
    );
    expect(r.spoken).toBe('Harborlight: 4 open. Waiting on you: 1 — “b”.');
    expect(r.detail).toEqual(['In progress: “a”.', 'Done recently: “c”.']);
    expect(r.asking).toBe(false);
  });
  it('speaks the second sentence when nothing is waiting', () => {
    const r = shapeReply('One. Two. Three.');
    expect(r.spoken).toBe('One. Two.');
    expect(r.detail).toEqual(['Three.']);
  });
  it('speaks a question on its own and says it is asking', () => {
    const r = shapeReply('Heard: "open it". Did you mean A or B? Say first or second.');
    expect(r.spoken).toBe('Did you mean A or B?');
    expect(r.detail).toEqual(['Say first or second.']);
    expect(r.asking).toBe(true);
  });
  it('caps the spoken part at forty words', () => {
    const long = `${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')}.`;
    const r = shapeReply(long);
    expect(r.spoken.split(/\s+/)).toHaveLength(40);
    expect(r.spoken.endsWith('…')).toBe(true);
  });
  it('splits on sentence ends only where the next one starts', () => {
    expect(sentences('Version 1.2 is out. Next')).toEqual(['Version 1.2 is out.', 'Next']);
  });
});

describe('goalAsk / namedGoalAsk', () => {
  it('hears a goal asked about without a name', () => {
    expect(goalAsk('how is the goal going?')).toBe(true);
    expect(goalAsk("How's my goal doing")).toBe(true);
    expect(goalAsk('goal status')).toBe(true);
    expect(goalAsk('give me an update on the goal')).toBe(false);
    expect(goalAsk('status of the goal')).toBe(true);
    expect(goalAsk('open the second goal')).toBe(false);
    expect(goalAsk('how are we doing')).toBe(false);
  });
  it('names the goal when one is named', () => {
    expect(namedGoalAsk('how is the sign in goal going')).toBe('sign in');
    expect(namedGoalAsk('how is the goal going')).toBeNull();
  });
});

describe('SpokenAnswerer', () => {
  const GOALS = [
    { id: 'g1', title: 'Harborlight sign in' },
    { id: 'g2', title: 'Riverbend import' },
  ];

  it('answers a status ask through the router, wake word stripped', async () => {
    const b = board(GOALS);
    const a = new SpokenAnswerer(b, 'w1');
    const r = await a.answer('Claude, give me a status update', ACTOR, undefined);
    expect(b.heard).toEqual(['give me a status update']);
    expect(r.spoken).toBe(
      'Harborlight: 4 open — 2 in progress, 2 to do, 1 done. Waiting on you: 1 — “pick a name” on “Saltmarsh”.',
    );
    expect(r.asking).toBe(false);
    expect(r.route).toBe('fast-path');
  });

  it('asks which goal, then answers the ordinal said next', async () => {
    const b = board(GOALS);
    const a = new SpokenAnswerer(b, 'w1');
    const q = await a.answer('Claude, how is the goal going?', ACTOR, undefined);
    expect(q.spoken).toBe('Which goal: Harborlight sign in or Riverbend import?');
    expect(q.choices).toEqual(['Harborlight sign in', 'Riverbend import']);
    expect(q.asking).toBe(true);
    expect(a.asking).toBe(true);
    expect(b.heard).toEqual([]);
    const r = await a.answer('the second one', ACTOR, undefined);
    expect(b.goalAsked).toEqual(['g2']);
    expect(r.spoken).toBe('Goal g2: 2 open. In progress: “x”.');
    expect(a.asking).toBe(false);
  });

  it('answers the goal question by name', async () => {
    const b = board(GOALS);
    const a = new SpokenAnswerer(b, 'w1');
    await a.answer('how is the goal going', ACTOR, undefined);
    await a.answer('riverbend import', ACTOR, undefined);
    expect(b.goalAsked).toEqual(['g2']);
  });

  it('something else said after the question is a new question', async () => {
    const b = board(GOALS);
    const a = new SpokenAnswerer(b, 'w1');
    await a.answer('how is the goal going', ACTOR, undefined);
    await a.answer('where are we', ACTOR, undefined);
    expect(b.goalAsked).toEqual([]);
    expect(b.heard).toEqual(['where are we']);
    expect(a.asking).toBe(false);
  });

  it('one goal is answered without asking, and a named goal directly', async () => {
    const one = board([GOALS[0] ?? { id: 'g1', title: 'x' }]);
    await new SpokenAnswerer(one, 'w1').answer('how is the goal going', ACTOR, undefined);
    expect(one.goalAsked).toEqual(['g1']);
    const b = board(GOALS);
    await new SpokenAnswerer(b, 'w1').answer(
      'how is the riverbend import goal going',
      ACTOR,
      undefined,
    );
    expect(b.goalAsked).toEqual(['g2']);
  });

  it('names three goals and then "another"', async () => {
    const b = board([
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
      { id: 'c', title: 'Gamma' },
      { id: 'd', title: 'Delta' },
    ]);
    const q = await new SpokenAnswerer(b, 'w1').answer('goal status', ACTOR, undefined);
    expect(q.spoken).toBe('Which goal: Alpha, Beta, Gamma or another?');
  });

  it('no goals: the router answers', async () => {
    const b = board([]);
    await new SpokenAnswerer(b, 'w1').answer('how is the goal going', ACTOR, undefined);
    expect(b.heard).toEqual(['how is the goal going']);
  });

  it('nothing heard says nothing', async () => {
    const b = board(GOALS);
    const r = await new SpokenAnswerer(b, 'w1').answer('  ', ACTOR, undefined);
    expect(r).toEqual({ spoken: '', points: [], detail: [], asking: false, route: 'none' });
  });

  /** A board whose router hands every request to the live lead. */
  const handedOff = (queueId?: string): SpokenBoard => ({
    async handle(): Promise<VoiceHandleResult> {
      return {
        ok: true,
        route: 'agent',
        ack: 'Heard: "x". On it.',
        ...(queueId ? { queueId } : {}),
      };
    },
    goalStatus: () => undefined,
    goals: () => [],
  });

  it('a request the lead took says nothing and waits on its queue row', async () => {
    const r = await new SpokenAnswerer(handedOff('q-ferry'), 'w1').answer(
      'go research ferry fares',
      ACTOR,
      undefined,
    );
    expect(r.spoken).toBe('');
    expect(r.points).toEqual([]);
    expect(r.awaiting).toBe('q-ferry');
  });

  it('a hand-off that was never queued still says its ack, so it is not dropped silently', async () => {
    const r = await new SpokenAnswerer(handedOff(), 'w1').answer(
      'go research ferry fares',
      ACTOR,
      undefined,
    );
    expect(r.spoken).toBe('On it.');
    expect(r).not.toHaveProperty('awaiting');
  });
});
