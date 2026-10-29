/**
 * A voice feedback recording open across a server restart carries on by
 * itself: the page's `VoiceSession` reconnects once the server is back, the
 * words said before the restart stay comments, and the words said while it
 * was down reach the new server.
 *
 * The page is the real `VoiceSession` and thread poster, over a real
 * WebSocket, against two real servers bound to one port and one data dir in
 * turn — the deploy restart of 29 October. The microphone is a stand-in the
 * test feeds frames into, the engines are mock ones and the tidier a fake, so
 * nothing plays, listens or reaches the network. Fixtures use the house
 * names.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Anchor } from '@claude-workspaces/core';
import type { PcmCaptureOpts } from '../../widget/src/voice/voice-audio.ts';
import { threadPoster } from '../../widget/src/voice/voice-post.ts';
import { type SocketLike, VoiceSession } from '../../widget/src/voice/voice-session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

setDefaultTimeout(60_000);

const AUTHOR = { id: 'known-riverbend', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
/** One mic frame: 50ms of silence at 16kHz. The mock engine reveals a word per frame. */
const FRAME = () => new Int16Array(800);

/** The tidier: one note per marker word it is handed, so each is traceable. */
const NOTES: Record<string, string> = {
  harborlight: 'The Harborlight heading is too small.',
  saltmarsh: 'The Saltmarsh button is hidden.',
  riverbend: 'The Riverbend footer is too faint.',
};
const tidy = async (req: { user: string }) => {
  const words = /<new_words>(.*)<\/new_words>/s.exec(req.user)?.[1] ?? '';
  const comments = Object.entries(NOTES)
    .filter(([w]) => words.includes(w))
    .map(([, text]) => ({ text }));
  return { text: JSON.stringify({ comments }) };
};

const anchorFor = (): Anchor => ({ kind: 'subject' });

describe('voice feedback across a server restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-reconnect-'));
  let handle: ServerHandle | null = null;

  afterAll(async () => {
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const boot = (port: number, words: string[][]): ServerHandle =>
    createServer({
      port,
      dataDir,
      transcription: createMockTranscriptionEngine(words.map((w) => ({ words: w }))),
      voiceFeedbackTidy: tidy,
      voiceKeepGraceMs: 0,
    });

  it('reconnects, keeps what was said before, and hears what was said while down', async () => {
    handle = boot(0, [
      ['harborlight', 'heading', 'too', 'small'],
      ['saltmarsh', 'button', 'hidden'],
    ]);
    const port = handle.port;
    const base = `http://127.0.0.1:${port}`;
    const WS = await seedBoard(base);
    const file = join(dataDir, 'riverbend.html');
    writeFileSync(file, '<!doctype html><html><body><h1>Riverbend</h1></body></html>');
    const made = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'riverbend-voice', type: 'mockup', sourceUrl: file }),
    });
    expect(made.status, await made.clone().text()).toBe(200);
    const docId = ((await made.json()) as { docId: string }).docId;

    let mic: PcmCaptureOpts | null = null;
    /** Every state the page was asked to draw, to read back what it showed. */
    const drawn: Array<{ state: string; reconnecting: boolean; note: string | null }> = [];
    const session: VoiceSession = new VoiceSession({
      url: `ws://127.0.0.1:${port}/workspaces/${WS}/docs/${docId}/voice`,
      openSocket: (u) => new WebSocket(u) as unknown as SocketLike,
      startCapture: async (opts) => {
        mic = opts;
        return { ok: true, capture: { stop: () => {} } };
      },
      poster: threadPoster(
        () => `${base}/workspaces/${WS}/docs/${docId}/threads`,
        (url, body) =>
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        () => AUTHOR,
      ),
      author: () => AUTHOR,
      catalog: () => [{ i: 0, tag: 'h1', text: 'Riverbend' }],
      anchorFor,
      onChange: () =>
        drawn.push({
          state: session.state,
          reconnecting: session.reconnecting,
          note: session.note,
        }),
    });
    const speak = (n: number) => {
      for (let i = 0; i < n; i++) mic?.onFrame(FRAME());
    };
    const notes = (h: ServerHandle) =>
      h.docStore
        .listThreads(docId)
        .flatMap((t) => t.comments.filter((c) => c.voice).map((c) => c.text));

    await session.start();
    await waitFor(() => session.state === 'recording', { describe: 'recording' });

    // A note finished before the restart: the page posts it itself.
    speak(5);
    await waitFor(() => notes(handle as ServerHandle).includes(NOTES.harborlight), {
      timeout: 10_000,
      describe: 'the first note posted',
    });
    // Words still being said when the restart comes.
    speak(3);
    await waitFor(() => session.pending.includes('hidden'), { describe: 'words pending' });

    const before = drawn.length;
    await handle.stop();
    handle = null;
    await waitFor(() => session.reconnecting, { describe: 'the page saw the drop' });
    // Said while the server is down: held for the next one.
    speak(4);

    handle = boot(port, [['riverbend', 'footer', 'faint']]);
    await waitFor(() => !session.reconnecting && session.state === 'recording', {
      timeout: 5_000,
      describe: 'reconnected within 5s of the server coming back',
    });
    await waitFor(() => notes(handle as ServerHandle).includes(NOTES.riverbend), {
      timeout: 10_000,
      describe: 'the words said while down became a note',
    });

    const after = notes(handle);
    expect(after.filter((t) => t === NOTES.harborlight)).toHaveLength(1);
    expect(
      after.filter((t) => t === NOTES.saltmarsh),
      'pending words kept',
    ).toHaveLength(1);
    expect(after.filter((t) => t === NOTES.riverbend)).toHaveLength(1);

    // One steady state through the outage: never idle, never an error, and
    // the reconnecting flag set once and cleared once — not once per attempt.
    const outage = drawn.slice(before);
    expect(outage.every((d) => d.state !== 'idle')).toBe(true);
    expect(outage.every((d) => d.note === null)).toBe(true);
    const flips = outage.filter((d, i) => i > 0 && d.reconnecting !== outage[i - 1]?.reconnecting);
    expect(outage[0]?.reconnecting).toBe(true);
    expect(flips.map((d) => d.reconnecting)).toEqual([false]);

    session.stop();
    await waitFor(() => session.state === 'idle', { describe: 'stopped' });
  });
});
