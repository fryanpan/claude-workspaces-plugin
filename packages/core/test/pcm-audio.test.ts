import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioPump, createResampler } from '../src/pcm-audio.ts';

/**
 * The audio graph both captures stream through — the meeting's and voice
 * feedback's. The DSP itself is exercised by `meeting-audio.test.ts`, which
 * imports it through the app's re-export; what is here is the graph behind
 * its seam: which node it builds, what reaches `onBlock`, and what Stop lets
 * go of. No audio hardware — a context that records what was asked of it.
 */

interface Recorded {
  calls: string[];
  ctx: AudioContext;
}

function fakeContext(opts: { worklet: boolean; state?: AudioContextState }): Recorded {
  const calls: string[] = [];
  const node = (name: string) => ({
    connect: () => calls.push(`${name}.connect`),
    disconnect: () => calls.push(`${name}.disconnect`),
  });
  const ctx = {
    sampleRate: 44_100,
    state: opts.state ?? 'running',
    resume: async () => {
      calls.push('resume');
    },
    close: async () => {
      calls.push('close');
    },
    destination: {},
    createMediaStreamSource: () => node('source'),
    audioWorklet: {
      addModule: async () => {
        if (!opts.worklet) throw new Error('no worklet here');
        calls.push('addModule');
      },
    },
    createScriptProcessor: () => ({ ...node('processor'), onaudioprocess: null }),
    createGain: () => ({ ...node('mute'), gain: { value: 1 } }),
  };
  return { calls, ctx: ctx as unknown as AudioContext };
}

const stream = {} as MediaStream;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAudioPump', () => {
  it('streams worklet blocks to onBlock and lets go of the graph on Stop', async () => {
    const ports: Array<{ onmessage: ((ev: MessageEvent) => void) | null }> = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pcm', revokeObjectURL: () => {} });
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = { onmessage: null as ((ev: MessageEvent) => void) | null };
        constructor() {
          ports.push(this.port);
        }
        disconnect(): void {}
      },
    );
    const { calls, ctx } = fakeContext({ worklet: true, state: 'suspended' });
    const pump = await createAudioPump(stream, ctx);
    expect(pump.sampleRate).toBe(44_100);
    expect(calls, 'a context made by the tap is resumed, not replaced').toContain('resume');
    expect(calls).toContain('addModule');

    const blocks: Float32Array[] = [];
    pump.onBlock = (b) => blocks.push(b);
    ports[0]?.onmessage?.({ data: new Float32Array([0.25]) } as MessageEvent);
    expect(blocks.map((b) => Array.from(b))).toEqual([[0.25]]);

    pump.stop();
    expect(ports[0]?.onmessage, 'no blocks after Stop').toBeNull();
    expect(calls).toContain('source.disconnect');
    expect(calls).toContain('close');
  });

  it('falls back to a muted ScriptProcessor where there is no worklet', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pcm', revokeObjectURL: () => {} });
    const { calls, ctx } = fakeContext({ worklet: false });
    let processor: { onaudioprocess: ((ev: AudioProcessingEvent) => void) | null } | undefined;
    let gain: { gain: { value: number } } | undefined;
    const make = ctx.createScriptProcessor.bind(ctx);
    const makeGain = ctx.createGain.bind(ctx);
    Object.assign(ctx, {
      createScriptProcessor: (...a: [number, number, number]) => {
        processor = make(...a) as unknown as typeof processor;
        return processor;
      },
      createGain: () => {
        gain = makeGain() as unknown as typeof gain;
        return gain;
      },
    });
    const pump = await createAudioPump(stream, ctx);
    expect(calls, 'pulled through the destination').toEqual(
      expect.arrayContaining(['processor.connect', 'mute.connect']),
    );
    expect(gain?.gain.value, 'muted, so the room never hears itself').toBe(0);

    const blocks: number[][] = [];
    pump.onBlock = (b) => blocks.push(Array.from(b));
    processor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) },
    } as unknown as AudioProcessingEvent);
    expect(blocks).toEqual([[0.5, -0.5]]);

    pump.stop();
    expect(processor?.onaudioprocess).toBeNull();
    expect(calls).toEqual(expect.arrayContaining(['mute.disconnect', 'close']));
  });

  it('refuses with a named error on a browser with no AudioContext at all', async () => {
    vi.stubGlobal('window', {});
    await expect(createAudioPump(stream)).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});

describe('createResampler', () => {
  it('carries its phase from one block to the next', () => {
    const down = createResampler(48_000, 16_000);
    expect(Array.from(down(new Float32Array([0, 1, 2, 3, 4, 5])))).toEqual([0, 3]);
    expect(Array.from(down(new Float32Array([6, 7, 8, 9, 10, 11])))).toEqual([6, 9]);
  });
});
