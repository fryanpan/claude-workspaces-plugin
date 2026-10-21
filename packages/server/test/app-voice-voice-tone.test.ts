/**
 * An app voice line in a voice and a tone the page names: what reaches the
 * engine, what is refused before it does, and what the cut-in test makes of
 * a tag. The Soniox voice runs over a fake of Soniox's socket that knows two
 * voices, so an unknown one is answered the way Soniox answers it. No
 * network, no key, no billed call.
 */
import { describe, expect, it } from 'bun:test';
import type { AppVoiceServerMessage } from '@claude-workspaces/core/app-voice';
import { AppVoiceSession } from '../src/app-voice/session.ts';
import { SONIOX_TTS_VOICE, type SpokenVoice, createSonioxVoice } from '../src/spoken-reply/tts.ts';
import type { EngineSocketArgs } from '../src/transcribe-assemblyai.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

/** Soniox's socket, as far as a line needs it: an unknown voice is an error. */
function fakeSoniox(voices = [SONIOX_TTS_VOICE, 'Riverbend']) {
  const configs: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const factory = (a: EngineSocketArgs) => {
    queueMicrotask(() => a.onOpen());
    return {
      send: (d: string | Uint8Array) => {
        const m = JSON.parse(String(d)) as Record<string, unknown>;
        if (m.api_key !== undefined) {
          configs.push(m);
          if (!voices.includes(String(m.voice))) {
            queueMicrotask(() =>
              a.onMessage(JSON.stringify({ error_code: 400, error_message: 'Invalid voice.' })),
            );
          }
          return;
        }
        if (typeof m.text !== 'string') return;
        texts.push(m.text);
        queueMicrotask(() => {
          a.onMessage(JSON.stringify({ stream_id: m.stream_id, audio: 'AQACAA==' }));
          a.onMessage(JSON.stringify({ stream_id: m.stream_id, audio: '', audio_end: true }));
        });
      },
      close: () => {},
    };
  };
  return { configs, texts, factory };
}

function session(voice: SpokenVoice, listener: TranscriptionEngine | null = null) {
  const frames: AppVoiceServerMessage[] = [];
  const s = new AppVoiceSession({
    voice,
    listener,
    say: null,
    sendJson: (m) => frames.push(m),
    sendAudio: () => {},
    freshToken: () => ({ token: 't', expiresAt: 0 }),
    every: () => () => {},
    hangUp: () => {},
  });
  s.open();
  return { s, of: (t: string) => frames.filter((f) => f.type === t) };
}

const speak = (s: AppVoiceSession, m: Record<string, unknown>) =>
  s.onText(JSON.stringify({ type: 'speak', ...m }));

describe('an app voice line in a named voice and tone', () => {
  it('speaks in the voice the line names, with the warm tag ahead of the text', async () => {
    const soniox = fakeSoniox();
    const { s, of } = session(createSonioxVoice({ apiKey: 'k', socketFactory: soniox.factory }));
    speak(s, { text: 'Welcome to Riverbend.', voice: 'Riverbend', tone: 'warm', id: 'a' });
    await waitFor(() => of('spoken').length === 1, { describe: 'the line was said' });
    expect(soniox.configs[0]?.voice).toBe('Riverbend');
    expect(soniox.texts).toEqual(['[warm] Welcome to Riverbend.']);
    expect(of('spoken')).toEqual([{ type: 'spoken', id: 'a', stopped: false }]);
  });

  it('speaks in the default voice with the text untouched when the line names neither', async () => {
    const soniox = fakeSoniox();
    const { s, of } = session(createSonioxVoice({ apiKey: 'k', socketFactory: soniox.factory }));
    speak(s, { text: 'Welcome to Riverbend.', id: 'a' });
    await waitFor(() => of('spoken').length === 1, { describe: 'the line was said' });
    expect(soniox.configs[0]?.voice).toBe(SONIOX_TTS_VOICE);
    expect(soniox.texts).toEqual(['Welcome to Riverbend.']);
  });

  it('passes a tag the text already holds through verbatim', async () => {
    const soniox = fakeSoniox();
    const { s, of } = session(createSonioxVoice({ apiKey: 'k', socketFactory: soniox.factory }));
    speak(s, { text: '[delighted] Saltmarsh is open.', voice: 'Riverbend', id: 'a' });
    await waitFor(() => of('spoken').length === 1, { describe: 'the line was said' });
    expect(soniox.configs[0]?.voice).toBe('Riverbend');
    expect(soniox.texts).toEqual(['[delighted] Saltmarsh is open.']);
  });

  it('refuses a voice that is not a plain name, and a tone not on the list, before the engine', async () => {
    let asked = 0;
    const voice: SpokenVoice = {
      name: 'counting',
      speak: async () => void asked++,
    };
    const { s, of } = session(voice);
    speak(s, { text: 'Hello.', voice: '../Riverbend', id: 'a' });
    speak(s, { text: 'Hello.', voice: 'M'.repeat(33), id: 'b' });
    speak(s, { text: 'Hello.', voice: 'Riverbend', tone: 'shouty', id: 'c' });
    speak(s, { text: 'Hello.', tone: 'warm] [angry', id: 'd' });
    await waitFor(() => of('error').length === 4, { describe: 'four refusals' });
    expect(
      of('error').map((e) => [(e as { code: string }).code, (e as { id?: string }).id]),
    ).toEqual([
      ['bad_voice', 'a'],
      ['bad_voice', 'b'],
      ['bad_tone', 'c'],
      ['bad_tone', 'd'],
    ]);
    expect(of('speaking')).toEqual([]);
    expect(asked).toBe(0);
  });

  it("sends Soniox's refusal of an unknown voice to the app as an error, and ends the line", async () => {
    const soniox = fakeSoniox();
    const { s, of } = session(createSonioxVoice({ apiKey: 'k', socketFactory: soniox.factory }));
    speak(s, { text: 'Hello.', voice: 'Harborlight', id: 'a' });
    await waitFor(() => of('spoken').length === 1, { describe: 'the line ended' });
    expect(soniox.configs[0]?.voice).toBe('Harborlight');
    expect(of('error')).toMatchObject([{ type: 'error', code: 'voice_failed', id: 'a' }]);
    expect(of('spoken')).toEqual([{ type: 'spoken', id: 'a', stopped: true }]);
  });

  it('does not take a heard tag word for the echo of the line', async () => {
    const release: (() => void)[] = [];
    const voice: SpokenVoice = {
      name: 'held',
      speak: (_t, _a, signal) =>
        new Promise<void>((resolve) => {
          release.push(resolve);
          signal.addEventListener('abort', () => resolve());
        }),
    };
    let ears: TranscriptionOpenOpts | undefined;
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open(opts) {
        ears = opts;
        return { send: () => {}, close: async () => {} };
      },
    };
    const { s, of } = session(voice, listener);
    s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => ears !== undefined, { describe: 'listener open' });
    speak(s, { text: '[calm] [sincerely] Riverbend is ahead.', id: 'a' });
    await waitFor(() => of('speaking').length === 1, { describe: 'speaking' });
    ears?.onTurn({ turn: 0, text: 'Riverbend is ahead', final: false });
    expect(of('cut-in')).toEqual([]);
    ears?.onTurn({ turn: 1, text: 'Calm, sincerely.', final: true });
    expect(of('cut-in')).toEqual([{ type: 'cut-in', text: 'Calm, sincerely.', id: 'a' }]);
  });
});
