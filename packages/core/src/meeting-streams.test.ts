import { describe, expect, it } from 'vitest';
import {
  COMBINED_SOURCE,
  MeetingTurnMerger,
  describeCaptureSource,
  groupForStream,
  groupLabel,
  namespacedSpeaker,
  parseCaptureSource,
  parseNamespacedSpeaker,
  sourceForStreams,
  streamForTagByte,
  streamsForSource,
  tagAudioFrame,
  untagAudioFrame,
} from './meeting-streams.ts';
import { parseMeetingClientMessage, speakerDisplayName } from './meeting.ts';
import { parseSpeakerTagHref, renderSpeakerTag } from './speaker-tags.ts';

describe('capture sources', () => {
  it('opens the microphone before the share picker for a combined capture', () => {
    expect(streamsForSource(COMBINED_SOURCE)).toEqual(['mic', 'system']);
  });

  it('opens exactly one stream for a single-stream source', () => {
    expect(streamsForSource('mic')).toEqual(['mic']);
    expect(streamsForSource('system')).toEqual(['system']);
  });

  it('names the source a set of opened streams adds up to', () => {
    expect(sourceForStreams(['mic', 'system'])).toBe(COMBINED_SOURCE);
    expect(sourceForStreams(['system'])).toBe('system');
    expect(sourceForStreams(['mic'])).toBe('mic');
    expect(sourceForStreams([])).toBeUndefined();
  });

  it('refuses a source name this build does not know', () => {
    expect(parseCaptureSource('mic+bot')).toBeUndefined();
    expect(parseCaptureSource(undefined)).toBeUndefined();
    expect(parseCaptureSource(COMBINED_SOURCE)).toBe(COMBINED_SOURCE);
  });

  it('describes both sources in words for a record a person reads', () => {
    expect(describeCaptureSource(COMBINED_SOURCE)).toContain('microphone');
    expect(describeCaptureSource(COMBINED_SOURCE)).toContain("Mac's audio");
  });
});

describe('groups', () => {
  it('puts the microphone in the room and the Mac in the remote group', () => {
    expect(groupForStream('mic')).toBe('room');
    expect(groupForStream('system')).toBe('remote');
    expect(groupLabel(groupForStream('mic'))).toBe('Room');
    expect(groupLabel(groupForStream('system'))).toBe('Remote');
  });
});

describe('speaker namespacing', () => {
  it('keeps one engine label from two streams apart', () => {
    expect(namespacedSpeaker('mic', 'A')).not.toBe(namespacedSpeaker('system', 'A'));
  });

  it('round-trips a namespaced label back to its group and engine label', () => {
    const label = namespacedSpeaker('system', 'B');
    expect(parseNamespacedSpeaker(label)).toEqual({ group: 'remote', base: 'B' });
  });

  it('reads a single-stream meeting label as having no group at all', () => {
    expect(parseNamespacedSpeaker('A')).toBeNull();
    expect(parseNamespacedSpeaker(':A')).toBeNull();
    expect(parseNamespacedSpeaker('room:')).toBeNull();
    expect(parseNamespacedSpeaker('bot:A')).toBeNull();
  });

  it('shows the group on an unnamed voice so two Speaker As read apart', () => {
    expect(speakerDisplayName(namespacedSpeaker('mic', 'A'), {})).toBe('Room Speaker A');
    expect(speakerDisplayName(namespacedSpeaker('system', 'A'), {})).toBe('Remote Speaker A');
  });

  it('keeps the group beside a voice the person has named', () => {
    const remote = namespacedSpeaker('system', 'A');
    expect(speakerDisplayName(remote, { [remote]: 'Dana' })).toBe('Dana (Remote)');
  });

  it('leaves an old single-stream label reading exactly as it did', () => {
    expect(speakerDisplayName('A', {})).toBe('Speaker A');
    expect(speakerDisplayName('A', { A: 'Bryan' })).toBe('Bryan');
  });

  it('survives the speaker-tag href a composed note carries', () => {
    const label = namespacedSpeaker('system', 'A');
    const tag = renderSpeakerTag(label, { [label]: 'Dana' });
    const href = /\]\(([^)]+)\)/.exec(tag)?.[1] ?? '';
    expect(parseSpeakerTagHref(href)?.label).toBe(label);
  });

  it('fits inside the length a name_speaker frame will accept', () => {
    const frame = parseMeetingClientMessage(
      JSON.stringify({
        type: 'name_speaker',
        speaker: namespacedSpeaker('system', 'A'),
        name: 'Dana',
      }),
    );
    expect(frame).toEqual({ type: 'name_speaker', speaker: 'remote:A', name: 'Dana' });
  });
});

describe('the start frame', () => {
  const start = (source: unknown) =>
    parseMeetingClientMessage(
      JSON.stringify({
        type: 'start',
        sampleRate: 16000,
        encoding: 'pcm_s16le',
        mode: 'conversation',
        source,
      }),
    );

  it('carries a combined source through', () => {
    expect(start(COMBINED_SOURCE)).toMatchObject({ source: COMBINED_SOURCE });
  });

  it('still carries the Mac-audio-only source old clients send', () => {
    expect(start('system')).toMatchObject({ source: 'system' });
  });

  it('leaves the field off for the microphone, as it always did', () => {
    expect(start('mic')).not.toHaveProperty('source');
    expect(start(undefined)).not.toHaveProperty('source');
  });

  it('drops a source name it does not know rather than refusing the meeting', () => {
    const frame = start('speakers');
    expect(frame).not.toBeNull();
    expect(frame).not.toHaveProperty('source');
  });
});

describe('audio frame tags', () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);

  it('round-trips a frame back to the stream that sent it', () => {
    for (const stream of ['mic', 'system'] as const) {
      const split = untagAudioFrame(tagAudioFrame(stream, pcm));
      expect(split?.stream).toBe(stream);
      expect([...(split?.chunk ?? [])]).toEqual([1, 2, 3, 4]);
    }
  });

  it('gives the two streams different tag bytes', () => {
    expect(tagAudioFrame('mic', pcm)[0]).not.toBe(tagAudioFrame('system', pcm)[0]);
  });

  it('refuses a tag byte no client should send rather than guessing a stream', () => {
    expect(streamForTagByte(9)).toBeNull();
    expect(untagAudioFrame(new Uint8Array([9, 1, 2]))).toBeNull();
  });

  it('refuses a frame with a tag and no audio behind it', () => {
    expect(untagAudioFrame(new Uint8Array([0]))).toBeNull();
    expect(untagAudioFrame(new Uint8Array([]))).toBeNull();
  });
});

describe('merging two engines onto one turn numbering', () => {
  it('gives two streams claiming the same engine turn different ids', () => {
    const merger = new MeetingTurnMerger();
    expect(merger.idFor('mic', 0)).not.toBe(merger.idFor('system', 0));
  });

  it('gives a revision of a turn the id that turn already had', () => {
    const merger = new MeetingTurnMerger();
    const first = merger.idFor('system', 4);
    merger.idFor('mic', 0);
    merger.idFor('mic', 1);
    expect(merger.idFor('system', 4)).toBe(first);
  });

  it('numbers turns in arrival order, so a lagging stream never runs backwards', () => {
    const merger = new MeetingTurnMerger();
    // The microphone is nine turns ahead when the Mac's first turn lands.
    const ids: number[] = [];
    for (let t = 0; t < 9; t++) ids.push(merger.idFor('mic', t));
    ids.push(merger.idFor('system', 0));
    ids.push(merger.idFor('mic', 9));
    ids.push(merger.idFor('system', 1));
    const ascending = ids.every((id, i) => i === 0 || id > (ids[i - 1] as number));
    expect(ascending).toBe(true);
  });
});
