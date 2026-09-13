import { describe, expect, it } from 'vitest';
import {
  MAX_VOICE_RAW,
  MAX_VOICE_TARGETS,
  VOICE_TARGET_TEXT,
  parseVoiceClientMessage,
  parseVoiceServerMessage,
  parseVoiceTargets,
  readVoiceNote,
} from '../src/voice-feedback.ts';

const CLIP = '/workspaces/riverbend/docs/harborlight-mock/voice-feedback/seg-3.wav#t=12.4,31';

describe('readVoiceNote', () => {
  it('accepts a clip on this server’s recording path', () => {
    expect(readVoiceNote({ clip: CLIP, raw: 'the save button' })).toEqual({
      clip: CLIP,
      raw: 'the save button',
    });
  });

  it('refuses anything that is not a same-origin recording with a time range', () => {
    for (const clip of [
      `https://elsewhere.example${CLIP}`,
      CLIP.replace('#t=12.4,31', ''),
      CLIP.replace('seg-3.wav', 'seg-3.mp3'),
      '/workspaces/riverbend/docs/a/b/voice-feedback/seg-1.wav#t=0,1',
      'javascript:alert(1)',
    ]) {
      expect(readVoiceNote({ clip, raw: 'x' }), clip).toBeUndefined();
    }
    expect(readVoiceNote({ clip: CLIP, raw: 'x'.repeat(MAX_VOICE_RAW + 1) })).toBeUndefined();
    expect(readVoiceNote({ clip: CLIP })).toBeUndefined();
    expect(readVoiceNote('nope')).toBeUndefined();
    expect(readVoiceNote(null)).toBeUndefined();
  });
});

describe('parseVoiceTargets', () => {
  it('drops malformed entries, caps text and the list, keeps valid parents', () => {
    const out = parseVoiceTargets([
      { i: 0, tag: 'header', text: 'Riverbend', hint: 'top-bar' },
      { i: 1, tag: 'BUTTON', text: 'bad tag' },
      { i: -1, tag: 'span' },
      { i: 2, tag: 'span', text: 'x'.repeat(200), parent: 0, label: '' },
      { i: 3, tag: 'div', parent: 100_000 },
      null,
      'string',
    ]);
    expect(out).toEqual([
      { i: 0, tag: 'header', text: 'Riverbend', hint: 'top-bar' },
      { i: 2, tag: 'span', text: 'x'.repeat(VOICE_TARGET_TEXT), parent: 0 },
      { i: 3, tag: 'div', text: '' },
    ]);
    const many = Array.from({ length: MAX_VOICE_TARGETS + 50 }, (_, i) => ({
      i: i % 10,
      tag: 'p',
    }));
    expect(parseVoiceTargets(many)).toHaveLength(MAX_VOICE_TARGETS);
    expect(parseVoiceTargets('nope')).toBeNull();
  });
});

describe('parseVoiceClientMessage', () => {
  const p = (m: unknown) => parseVoiceClientMessage(JSON.stringify(m));

  it('reads each frame the page sends', () => {
    expect(p({ type: 'start', sampleRate: 16_000, targets: [{ i: 0, tag: 'main' }] })).toEqual({
      type: 'start',
      sampleRate: 16_000,
      targets: [{ i: 0, tag: 'main', text: '' }],
    });
    expect(p({ type: 'targets', targets: [] })).toEqual({ type: 'targets', targets: [] });
    expect(p({ type: 'pin', target: 4 })).toEqual({ type: 'pin', target: 4 });
    expect(p({ type: 'pin', target: null })).toEqual({ type: 'pin', target: null });
    expect(p({ type: 'move', key: 'v2', target: 1 })).toEqual({
      type: 'move',
      key: 'v2',
      target: 1,
    });
    expect(p({ type: 'posted', key: 'v1', threadId: 'th_abc-1' })).toEqual({
      type: 'posted',
      key: 'v1',
      threadId: 'th_abc-1',
    });
    expect(p({ type: 'stop' })).toEqual({ type: 'stop' });
  });

  it('refuses malformed frames rather than guessing', () => {
    expect(p({ type: 'start', sampleRate: 48_000, targets: [] })).toBeNull();
    expect(p({ type: 'start', sampleRate: 16_000 })).toBeNull();
    expect(p({ type: 'pin' })).toBeNull();
    expect(p({ type: 'pin', target: 1.5 })).toBeNull();
    expect(p({ type: 'move', key: '../v1', target: 1 })).toBeNull();
    expect(p({ type: 'move', key: 'v1' })).toBeNull();
    expect(p({ type: 'posted', key: 'v1', threadId: '../../etc' })).toBeNull();
    expect(p({ type: 'dance' })).toBeNull();
    expect(p(null)).toBeNull();
    expect(parseVoiceClientMessage('{not json')).toBeNull();
    expect(parseVoiceClientMessage(42)).toBeNull();
  });
});

describe('parseVoiceServerMessage', () => {
  it('keeps whole frames and drops half-read comments', () => {
    const comment = {
      type: 'comment',
      key: 'v1',
      text: 't',
      target: null,
      raw: 'r',
      clip: CLIP,
      final: false,
    };
    expect(parseVoiceServerMessage(JSON.stringify(comment))).toEqual(comment);
    expect(parseVoiceServerMessage(JSON.stringify({ ...comment, raw: undefined }))).toBeNull();
    expect(parseVoiceServerMessage(JSON.stringify({ type: 'ready', segment: 2 }))).toEqual({
      type: 'ready',
      segment: 2,
    });
    expect(parseVoiceServerMessage(JSON.stringify({ type: 'future' }))).toBeNull();
    expect(parseVoiceServerMessage('nope')).toBeNull();
  });
});
