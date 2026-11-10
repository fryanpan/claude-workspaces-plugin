/**
 * The spoken reply's audio arrives in chunks and has to play as one stream.
 * The chunks' sizes are the network's and the voice's, so they must not be
 * audible: these cases hold the player's output over a clock the test owns
 * and compare it across chunkings. `spoken-player-joins-browser.test.ts` is
 * the same check through a real browser's renderer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type PlaybackContext,
  type SpokenPlayer,
  createSpokenPlayer,
} from '../src/board/spoken-reply-audio.ts';
import { createLeadLineVoice } from '../src/lead-chat/lead-chat-meeting-voice.ts';

const VOICE_RATE = 24_000;

interface Scheduled {
  at: number;
  rate: number;
  samples: Float32Array;
}

function recordingContext(sampleRate: number) {
  const scheduled: Scheduled[] = [];
  const ctx = {
    sampleRate,
    currentTime: 0.0123,
    state: 'running',
    resume: async () => {},
    destination: {} as AudioNode,
    createBuffer: (_c: number, length: number, rate: number) => {
      const held = { length, rate, samples: new Float32Array(length) };
      return {
        ...held,
        copyToChannel: (from: Float32Array) => held.samples.set(from),
        held,
      } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const src = {
        buffer: null as unknown as { held: { rate: number; samples: Float32Array } },
        connect: () => {},
        start: (at: number) =>
          scheduled.push({ at, rate: src.buffer.held.rate, samples: src.buffer.held.samples }),
        stop: () => {},
        onended: null,
      };
      return src as unknown as AudioBufferSourceNode;
    },
  };
  return { ctx: ctx as unknown as PlaybackContext & { currentTime: number }, scheduled };
}

/** A tone with a strong high partial, as PCM16 bytes. */
function voiceBytes(n: number): Uint8Array {
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) {
    const t = i / VOICE_RATE;
    const s = 0.3 * Math.sin(2 * Math.PI * 660 * t) + 0.2 * Math.sin(2 * Math.PI * 5000 * t);
    v.setInt16(i * 2, Math.round(s * 0x7fff), true);
  }
  return b;
}

function playerOn(ctx: PlaybackContext): SpokenPlayer {
  const player = createSpokenPlayer({ context: () => ctx, onFirstWord: () => {}, now: () => 0 });
  player.begin(VOICE_RATE);
  return player;
}

function joined(scheduled: Scheduled[]): Float32Array {
  const out = new Float32Array(scheduled.reduce((n, s) => n + s.samples.length, 0));
  let at = 0;
  for (const s of scheduled) {
    out.set(s.samples, at);
    at += s.samples.length;
  }
  return out;
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

function peakDifference(a: Float32Array, b: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    peak = Math.max(peak, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return peak;
}

describe('the joins between chunks of a spoken reply', () => {
  // A browser resamples each buffer on its own and holds the last sample at
  // the end, so a buffer at the voice's rate on a faster context clicks at
  // every join. Measured in Chromium: `spoken-player-joins-browser.test.ts`.
  it.each([48_000, 44_100])('hands the browser nothing to resample at %i Hz', (rate) => {
    const { ctx, scheduled } = recordingContext(rate);
    const player = playerOn(ctx);
    for (const c of chunked(voiceBytes(4_800), 960)) player.push(c);
    expect(scheduled.length).toBe(10);
    for (const s of scheduled) expect(s.rate).toBe(rate);
  });

  it.each([48_000, 44_100])(
    'plays the same samples however the voice cut them at %i Hz',
    (rate) => {
      const bytes = voiceBytes(4_800);
      const whole = recordingContext(rate);
      playerOn(whole.ctx).push(bytes);
      for (const size of [480, 962, 2_400]) {
        const cut = recordingContext(rate);
        const player = playerOn(cut.ctx);
        for (const c of chunked(bytes, size)) player.push(c);
        const a = joined(whole.scheduled);
        const b = joined(cut.scheduled);
        expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
        expect(peakDifference(a, b)).toBeLessThan(1e-6);
      }
    },
  );

  it.each([48_000, 44_100])(
    'starts each chunk on the frame the last one ended at %i Hz',
    (rate) => {
      const { ctx, scheduled } = recordingContext(rate);
      const player = playerOn(ctx);
      for (const c of chunked(voiceBytes(4_800), 962)) player.push(c);
      let frame = Math.round((scheduled[0]?.at ?? 0) * rate);
      for (const s of scheduled) {
        // Exactly on the frame grid: a browser that rounds a start to a frame
        // leaves a frame's gap or overlap otherwise.
        expect(Math.abs(s.at * rate - frame)).toBeLessThan(1e-6);
        frame += s.samples.length;
      }
    },
  );

  it('keeps samples aligned when a chunk ends halfway through one', () => {
    const bytes = voiceBytes(1_000);
    const whole = recordingContext(48_000);
    playerOn(whole.ctx).push(bytes);
    const cut = recordingContext(48_000);
    const player = playerOn(cut.ctx);
    for (const c of chunked(bytes, 401)) player.push(c);
    expect(peakDifference(joined(whole.scheduled), joined(cut.scheduled))).toBeLessThan(1e-6);
  });

  it('starts a chunk that arrives after the queue ran dry from silence', () => {
    const { ctx, scheduled } = recordingContext(48_000);
    const player = playerOn(ctx);
    // Cut away from a zero crossing of the tone.
    const [first, second] = chunked(voiceBytes(4_800), 4_802);
    player.push(first as Uint8Array);
    // The queue plays out, and the next chunk comes late.
    ctx.currentTime += 1;
    player.push(second as Uint8Array);
    const late = scheduled[1]?.samples ?? new Float32Array(0);
    const whole = recordingContext(48_000);
    playerOn(whole.ctx).push(voiceBytes(4_800));
    const reference = joined(whole.scheduled).subarray(scheduled[0]?.samples.length ?? 0);
    // Nonzero in the voice at this point, and ramped up from zero here.
    expect(Math.abs(reference[0] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.abs(late[0] ?? 1)).toBeLessThan(0.01);
    // The ramp is a few milliseconds: past it the voice is untouched.
    expect(peakDifference(late.subarray(480), reference.subarray(480))).toBeLessThan(1e-6);
  });
});

describe('a spoken reply on a network that delivers late', () => {
  it('starts again with twice the headroom each time the queue runs dry, up to a bound', () => {
    const { ctx, scheduled } = recordingContext(48_000);
    const player = playerOn(ctx);
    const leads: number[] = [];
    player.push(voiceBytes(480));
    for (let i = 0; i < 5; i++) {
      // Each chunk arrives after the one before it has played out.
      ctx.currentTime += 1;
      player.push(voiceBytes(480));
      leads.push(Math.round(((scheduled.at(-1)?.at ?? 0) - ctx.currentTime) * 1000));
    }
    expect(leads).toEqual([60, 120, 240, 240, 240]);
    expect(player.facts()).toMatchObject({ chunks: 6, underruns: 5, leadMs: 240 });
  });

  it('counts no underrun while the queue stays ahead of the clock', () => {
    const { ctx } = recordingContext(48_000);
    const player = playerOn(ctx);
    for (const c of chunked(voiceBytes(4_800), 962)) player.push(c);
    expect(player.facts()).toMatchObject({ underruns: 0, leadMs: 30 });
  });
});

describe('a meeting line, through the same player', () => {
  it('plays a streamed line at the context’s rate, whole, and says it played', async () => {
    const bytes = voiceBytes(4_800);
    const whole = recordingContext(48_000);
    playerOn(whole.ctx).push(bytes);
    const { ctx, scheduled } = recordingContext(48_000);
    const done: boolean[] = [];
    const voice = createLeadLineVoice({
      workspaceId: 'w-harbor',
      author: { id: 'known-alice', name: 'Alice', kind: 'known' },
      playbackContext: () => ctx,
      fetch: (async (_url: unknown) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const part of chunked(bytes, 1_001)) c.enqueue(part);
              c.close();
            },
          }),
          { headers: { 'x-sample-rate': String(VOICE_RATE) } },
        )) as typeof fetch,
      onPlaying: () => {},
      onDone: (_id, _turn, said) => done.push(said),
    });
    voice.play('lcm-1', 0.5);
    await vi.waitFor(() => expect(done).toEqual([true]));
    expect(scheduled.every((s) => s.rate === 48_000)).toBe(true);
    expect(peakDifference(joined(whole.scheduled), joined(scheduled))).toBeLessThan(1e-6);
  });
});
