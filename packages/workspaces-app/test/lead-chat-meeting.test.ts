/**
 * The lead chat's meeting on the device that records it
 * (`lead-chat-meeting.ts`): it starts the doc's meeting socket, tells the
 * board which recording it holds, posts each line said once, resumes the same
 * recording on the next page, and asks for a tap only where the microphone
 * cannot start without one. Socket, microphone and clock are fakes.
 */
import { describe, expect, it } from 'vitest';
import {
  TAP_NOTE,
  TAP_WAIT_MS,
  createLeadMeetingRun,
  recorderToken,
} from '../src/lead-chat/lead-chat-meeting.ts';
import {
  ALICE,
  fakeClock,
  fakeMeetingClient,
  fakeMic,
  fakeSockets,
  flush,
  meetingFixture,
} from './lead-chat-meeting-fakes.ts';

function setup(
  opts: {
    contextState?: 'running' | 'suspended';
    meeting?: ReturnType<typeof meetingFixture>;
  } = {},
) {
  const meeting = opts.meeting ?? meetingFixture();
  const fake = fakeMeetingClient(meeting);
  const net = fakeSockets();
  const mic = fakeMic(opts.contextState);
  const clock = fakeClock();
  const ctx = {} as AudioContext;
  const run = createLeadMeetingRun({
    workspaceId: 'w-harbor',
    author: ALICE,
    client: fake.client,
    recorder: 'rec-here',
    now: clock.now,
    schedule: clock.schedule,
    openSocket: net.openSocket,
    startCapture: mic.startCapture,
    createAudioContext: () => ctx,
  });
  return { meeting, fake, net, mic, clock, run, ctx };
}

describe('the lead chat meeting, on the device that records it', () => {
  it('opens the doc’s meeting socket, tells the board its recording, and posts each final line once', async () => {
    const { meeting, fake, net, mic, run, ctx } = setup();
    await run.begin(meeting, { gesture: true });
    expect(mic.contexts).toEqual([ctx]);
    const s = net.last();
    expect(s.url).toContain('/docs/d-saltmarsh/');
    s.onopen?.();
    expect(s.json()[0]).toMatchObject({ type: 'start', mode: 'conversation', handoff: true });
    expect(s.json()[0]).not.toHaveProperty('resume');

    s.say({ type: 'ready', meetingId: 'm-77' });
    await flush();
    expect(run.state().phase).toBe('recording');
    expect(fake.calls.find((c) => c.action === 'recording')?.body).toMatchObject({
      id: 'lcm-1',
      meetingId: 'm-77',
      recorder: 'rec-here',
    });

    s.say({ type: 'transcript', turn: 0, text: 'The slipway opens', final: false });
    expect(run.state().partial).toBe('The slipway opens');
    s.say({ type: 'transcript', turn: 0, text: 'The slipway opens at nine.', final: true });
    s.say({ type: 'transcript', turn: 0, text: 'The slipway opens at nine.', final: true });
    await flush();
    const lines = fake.calls.filter((c) => c.action === 'line');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toMatchObject({
      id: 'lcm-1',
      turn: 0,
      text: 'The slipway opens at nine.',
    });
    expect(run.state().partial).toBe('');
  });

  it('turns the note-taker off for a meeting with no notes', async () => {
    const { net, run } = setup();
    await run.begin(meetingFixture({ notes: 'none' }), { gesture: true });
    net.last().onopen?.();
    expect(net.last().json()[0]).toMatchObject({ type: 'start', notes: false });
    // Positive control: a meeting with notes never sends the field.
    const other = setup();
    await other.run.begin(meetingFixture({ notes: 'new' }), { gesture: true });
    other.net.last().onopen?.();
    expect(other.net.last().json()[0]).not.toHaveProperty('notes');
  });

  it('on the next page, asks for the same recording back, and needs no tap where the microphone runs', async () => {
    const { net, mic, clock, run } = setup({
      meeting: meetingFixture({ meetingId: 'm-77' }),
    });
    await run.begin(meetingFixture({ meetingId: 'm-77' }), { gesture: false });
    // No gesture, so no context made for it.
    expect(mic.contexts).toEqual([undefined]);
    const s = net.last();
    s.onopen?.();
    expect(s.json()[0]).toMatchObject({ type: 'start', resume: 'm-77' });
    expect(s.json()[0]).not.toHaveProperty('handoff');
    s.say({ type: 'ready', meetingId: 'm-77' });
    mic.emit(new Int16Array(320));
    clock.advance(TAP_WAIT_MS);
    expect(run.state().phase).toBe('recording');
  });

  it('asks for a tap when a resumed page’s microphone is held, and the tap starts it', async () => {
    const m = meetingFixture({ meetingId: 'm-77' });
    const { net, mic, clock, run } = setup({ contextState: 'suspended', meeting: m });
    await run.begin(m, { gesture: false });
    net.last().onopen?.();
    net.last().say({ type: 'ready', meetingId: 'm-77' });
    clock.advance(TAP_WAIT_MS);
    expect(run.state()).toMatchObject({ phase: 'tap', note: TAP_NOTE });
    run.tap();
    expect(mic.resumed).toBe(1);
    expect(run.state().phase).toBe('recording');
  });

  it('a page going away closes without ending; End meeting tells the server to stop', async () => {
    const { meeting, net, mic, run } = setup();
    await run.begin(meeting, { gesture: true });
    const s = net.last();
    s.onopen?.();
    s.say({ type: 'ready', meetingId: 'm-77' });
    run.release();
    expect(s.closed).toBe(true);
    expect(s.json().some((f) => f.type === 'stop')).toBe(false);
    expect(mic.stopped).toBe(1);

    const other = setup();
    await other.run.begin(other.meeting, { gesture: true });
    const s2 = other.net.last();
    s2.onopen?.();
    s2.say({ type: 'ready', meetingId: 'm-78' });
    other.run.stop();
    expect(s2.json().at(-1)).toEqual({ type: 'stop' });
    expect(other.run.state().phase).toBe('idle');
  });

  it('records into the notes doc the server hands back for a doc holding the person’s own writing', async () => {
    const { meeting, fake, net, run } = setup();
    await run.begin(meeting, { gesture: true });
    net.last().onopen?.();
    net.last().say({
      type: 'notes_doc',
      docId: 'd-rivernote',
      title: 'Riverbend notes',
      url: '/workspaces/w-harbor/docs/d-rivernote',
    });
    const s = net.last();
    expect(s.url).toContain('/docs/d-rivernote/');
    s.onopen?.();
    s.say({ type: 'ready', meetingId: 'm-80' });
    await flush();
    expect(fake.calls.find((c) => c.action === 'recording')?.body).toMatchObject({
      docId: 'd-rivernote',
      docTitle: 'Riverbend notes',
    });
  });
});

describe('the recorder token', () => {
  it('is minted once per tab and kept across page loads', () => {
    const m = new Map<string, string>();
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    const a = recorderToken(storage);
    expect(a).toMatch(/^rec-/);
    expect(recorderToken(storage)).toBe(a);
    expect(recorderToken({ getItem: () => null, setItem: () => {} })).not.toBe(a);
  });
});
