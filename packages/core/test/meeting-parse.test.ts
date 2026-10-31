import { describe, expect, it } from 'vitest';
import { parseMeetingClientMessage } from '../src/meeting-parse.ts';
import { MEETING_AUDIO_ENCODING } from '../src/meeting.ts';

/**
 * The frames a recording page sends the server's meeting socket that the lead
 * chat's meeting still sends since the doc's Record Audio went (2026-10-30):
 * a resume after a page move, and the report that no audio is arriving.
 * The parser is the server's only check on them. All values synthetic.
 */
const start = (extra: Record<string, unknown>) =>
  parseMeetingClientMessage(
    JSON.stringify({
      type: 'start',
      sampleRate: 16_000,
      encoding: MEETING_AUDIO_ENCODING,
      ...extra,
    }),
  );

describe('a start that resumes a meeting', () => {
  it('keeps a readable resume id and the audio it carried across the outage', () => {
    expect(start({ resume: 'm-riverbend-1', heldMs: 4_200.4 })).toMatchObject({
      resume: 'm-riverbend-1',
      heldMs: 4200,
    });
  });

  it('caps what it claims to have carried at the two-minute reconnect window', () => {
    expect(start({ resume: 'm-riverbend-1', heldMs: 3_600_000 })).toMatchObject({
      heldMs: 120_000,
    });
  });

  it('drops an id the server could never match, and with it the held audio', () => {
    const m = start({ resume: 'm riverbend/1', heldMs: 4_000 });
    expect(m).not.toBeNull();
    expect(m).not.toHaveProperty('resume');
    expect(m).not.toHaveProperty('heldMs');
  });

  it('reads held audio only beside a resume, and never a negative one', () => {
    expect(start({ heldMs: 4_000 })).not.toHaveProperty('heldMs');
    expect(start({ resume: 'm-riverbend-1', heldMs: -5 })).not.toHaveProperty('heldMs');
  });
});

describe('the report that no audio is arriving', () => {
  it('passes a known audio-context state and bounded counts', () => {
    expect(
      parseMeetingClientMessage(
        JSON.stringify({
          type: 'no_audio',
          contextState: 'suspended',
          sampleRate: 48_000,
          blocks: 12.6,
        }),
      ),
    ).toEqual({ type: 'no_audio', contextState: 'suspended', sampleRate: 48_000, blocks: 13 });
  });

  it('puts no page-written text in the log line: an unknown state and junk counts', () => {
    expect(
      parseMeetingClientMessage(
        JSON.stringify({
          type: 'no_audio',
          contextState: 'harborlight',
          sampleRate: 'x',
          blocks: 1e12,
        }),
      ),
    ).toEqual({ type: 'no_audio', contextState: 'unknown', sampleRate: 0, blocks: 1_000_000 });
  });
});
