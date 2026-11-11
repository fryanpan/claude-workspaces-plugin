/**
 * The lead chat voice while the page, or an app in a frame on it, speaks with
 * the browser's speech engine (9 Nov: a navigator's turn calls were sent up
 * as the owner's requests). The mic sends silence in their place, the
 * question stays open, and the reader is heard again once the app stops.
 * The socket, the microphone and the page's speech are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type LeadVoice, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { type FakeSocket, fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const ME = { id: 'known-alice', name: 'Alice', kind: 'known' };

let voice: LeadVoice | null = null;
afterEach(() => {
  voice?.destroy();
  voice = null;
});

async function listening() {
  const fake = fakeVoice();
  voice = createLeadVoice({
    ...fake.seams,
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
  return { ...fake, voice, ws };
}

/** For each audio frame the page sent, whether it carried any sound. */
const sounds = (ws: FakeSocket): boolean[] =>
  ws.sent
    .filter((d): d is Int16Array => d instanceof Int16Array)
    .map((pcm) => pcm.some((s) => s !== 0));

describe('the lead chat voice while an app on the page speaks', () => {
  it('sends silence in place of what the mic hears, and keeps the question open', async () => {
    const { voice, ws, speak, pageSpeech, mic } = await listening();
    speak();
    pageSpeech.set(true);
    speak();
    speak();
    expect(sounds(ws)).toEqual([true, false, false]);
    // As long as the mic's frames: the listener hears a quiet room.
    const last = ws.sent.at(-1) as Int16Array;
    expect(last.length).toBe(800);
    expect(voice.state()).toMatchObject({ phase: 'listening' });
    expect(ws.messages().map((m) => m.type)).toEqual(['start']);
    // The track is kept: a line every few seconds does not reopen the mic.
    expect(mic.pauses).toBe(0);
  });

  it('hears the reader again once the app stops, and asks what they said', async () => {
    const { voice, ws, speak, pageSpeech } = await listening();
    pageSpeech.set(true);
    speak();
    pageSpeech.set(false);
    speak();
    expect(sounds(ws)).toEqual([false, true]);
    ws.serve({ type: 'turn-end', text: 'what is next on Riverbend' });
    expect(voice.state()).toMatchObject({ phase: 'working', heard: 'what is next on Riverbend' });
  });

  it('watches the page only while voice is on', async () => {
    const { voice, pageSpeech } = await listening();
    expect(pageSpeech.speech.watching).toBe(1);
    voice.stop();
    expect(pageSpeech.speech.watching).toBe(0);
    voice.start();
    await settle();
    expect(pageSpeech.speech.watching).toBe(1);
  });

  it('forgets a line that was speaking when voice went off', async () => {
    const { voice, pageSpeech, speak, socket } = await listening();
    pageSpeech.set(true);
    voice.stop();
    voice.start();
    await settle();
    const ws = socket();
    ws.open();
    speak();
    expect(sounds(ws)).toEqual([true]);
  });
});
