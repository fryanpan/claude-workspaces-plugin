/**
 * The lead chat voice in a tab that is not the one the reader is on
 * (`listening-tab.ts` decides which): listening stays on, nothing goes up,
 * and the state says it is paused. Back on the tab, the next question
 * listens. The socket, the microphone and the tab election are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type LeadVoice, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';
import { fakePlayback } from './support/spoken-reply-harness.ts';

const ME = { id: 'known-alice', name: 'Alice', kind: 'known' };

let voice: LeadVoice | null = null;
afterEach(() => {
  voice?.destroy();
  voice = null;
});

async function listening() {
  const fake = fakeVoice();
  const playback = fakePlayback();
  voice = createLeadVoice({
    ...fake.seams,
    playbackContext: () => playback.ctx,
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: () => {},
  });
  voice.start();
  await settle();
  const ws = fake.socket();
  ws.open();
  return { ...fake, voice, ws, playback };
}

const starts = (ws: { messages(): Array<Record<string, unknown>> }): number =>
  ws.messages().filter((m) => m.type === 'start').length;

describe('the lead chat voice, in a tab the reader is not on', () => {
  it('sends nothing and says it is paused, with listening still on', async () => {
    const { voice, ws, speak, tabs } = await listening();
    expect(tabs.tab.joined).toBe(true);
    speak();
    expect(ws.frames()).toBe(1);
    tabs.set(false);
    speak();
    expect(ws.frames()).toBe(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', paused: true });
  });

  it('drops a question that heard nothing with its socket, and listens again once back', async () => {
    const { voice, ws, speak, tabs, socket } = await listening();
    tabs.set(false);
    expect(ws.closed).toBe(true);
    tabs.set(true);
    const next = socket();
    expect(next).not.toBe(ws);
    next.open();
    expect(starts(next)).toBe(1);
    speak();
    expect(next.frames()).toBe(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', paused: false });
  });

  it('asks what it had heard when the reader leaves mid-question', async () => {
    const { ws, tabs } = await listening();
    ws.serve({ type: 'heard', text: 'what is next on Riverbend' });
    tabs.set(false);
    expect(ws.closed).toBe(false);
    expect(ws.messages().at(-1)).toEqual({ type: 'end' });
  });

  it('ends an empty question when its socket still waits for the lead, and asks nothing', async () => {
    const { voice, ws, tabs } = await listening();
    // An earlier question the lead took and has not answered yet.
    ws.serve({ type: 'reply', spoken: '', detail: [], asking: false, route: 'agent' });
    tabs.set(false);
    expect(ws.closed).toBe(false);
    expect(ws.messages().at(-1)).toEqual({ type: 'end' });
    ws.serve({ type: 'turn-end', text: '' });
    expect(voice.state()).toMatchObject({ phase: 'listening', paused: true });
  });

  it('does not start the next question while paused, and starts it once back', async () => {
    const { voice, ws, speak, tabs } = await listening();
    ws.serve({ type: 'turn-end', text: 'what is next on Riverbend' });
    tabs.set(false);
    ws.serve({ type: 'reply', spoken: '', detail: [], asking: false, route: 'agent' });
    expect(starts(ws)).toBe(1);
    expect(voice.state()).toMatchObject({ phase: 'listening', paused: true });
    speak();
    expect(ws.frames()).toBe(0);
    tabs.set(true);
    expect(starts(ws)).toBe(2);
    speak();
    expect(ws.frames()).toBe(1);
  });

  it('leaves the election when voice goes off', async () => {
    const { voice, tabs } = await listening();
    voice.stop();
    expect(tabs.tab.joined).toBe(false);
    expect(voice.state().paused).toBe(false);
  });

  it('does not start a question over the one it asked when the reader comes back before it ends', async () => {
    const { voice, ws, tabs } = await listening();
    ws.serve({ type: 'heard', text: 'what is next on Riverbend' });
    tabs.set(false);
    tabs.set(true);
    expect(starts(ws)).toBe(1);
    expect(voice.state().phase).toBe('working');
    ws.serve({ type: 'turn-end', text: 'what is next on Riverbend' });
    expect(starts(ws)).toBe(1);
  });

  it('says no answer aloud while paused, and stops one it was saying', async () => {
    const { ws, tabs, playback } = await listening();
    const audio = (): void => ws.onmessage?.({ data: new Int16Array(240).buffer });
    ws.serve({ type: 'turn-end', text: 'what is next on Riverbend' });
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    audio();
    expect(playback.started).toHaveLength(1);
    tabs.set(false);
    expect(playback.stopped).toBe(1);
    audio();
    ws.serve({ type: 'audio-end' });
    // The next answer, all of it while paused.
    ws.serve({ type: 'audio-start', sampleRate: 24_000 });
    audio();
    expect(playback.started).toHaveLength(1);
  });

  it('opens no socket and changes no state as it is destroyed while paused', async () => {
    const fake = await listening();
    fake.tabs.set(false);
    const opened = fake.sockets.length;
    const v = fake.voice;
    v.destroy();
    voice = null;
    expect(fake.sockets.length).toBe(opened);
  });

  it('stays on when a paused tab comes back from the back-forward cache with no socket', async () => {
    const { voice, tabs } = await listening();
    tabs.set(false);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    expect(voice.state()).toMatchObject({ phase: 'listening', paused: true, notice: '' });
  });
});
