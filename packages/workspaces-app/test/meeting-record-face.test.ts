import { describe, expect, it } from 'vitest';
import {
  RECORD_MODES,
  RECORD_SOURCES,
  SOURCE_GLYPH,
  VOICES_GLYPH,
  everyRecordLabel,
  everyRecordSetting,
  recordFace,
  recordSetting,
} from '../src/meeting-record-face.ts';

/**
 * The vocabulary the Record button wears. The strip's own cases drive the
 * button; these pin the words, and the completeness the button's one width
 * depends on — the sizer reserves room for everything `everyRecordSetting`
 * lists, so a face that list does not cover is a face that resizes the pill.
 */
describe('recordSetting — the two axes, in the order Bryan named them', () => {
  it('is source then voices', () => {
    expect(recordSetting('mic', 'conversation')).toBe('Microphone · Multiple');
    expect(recordSetting('mic', 'solo')).toBe('Microphone · Just me');
    expect(recordSetting('mic+system', 'conversation')).toBe('Mac audio · Multiple');
    expect(recordSetting('bot', 'solo')).toBe('Meeting link · Just me');
  });
});

describe('recordFace', () => {
  it('reads Record Audio while idle and Recording while it runs, with the setting unchanged', () => {
    const idle = recordFace({ recording: false, source: 'mic', mode: 'conversation' });
    const live = recordFace({ recording: true, source: 'mic', mode: 'conversation' });
    expect(idle.label).toBe('Record Audio');
    expect(live.label).toBe('Recording');
    expect(idle.setting).toBe(live.setting);
  });

  it('spells both facts out for a screen reader — the separator is not read aloud', () => {
    expect(recordFace({ recording: false, source: 'mic+system', mode: 'solo' }).ariaLabel).toBe(
      'Record Audio — mac audio, just me',
    );
    expect(recordFace({ recording: true, source: 'bot', mode: 'conversation' }).ariaLabel).toBe(
      'Recording — meeting link, multiple speakers',
    );
  });

  it('says what a press does in the title, and both facts with it', () => {
    expect(recordFace({ recording: false, source: 'mic', mode: 'solo' }).title).toBe(
      'Record audio — Microphone · Just me',
    );
    expect(recordFace({ recording: true, source: 'mic', mode: 'solo' }).title).toContain(
      'open controls',
    );
  });
});

describe('the faces the sizer has to cover', () => {
  it('lists every combination of the two axes, so no state is unmeasured', () => {
    const every = everyRecordSetting();
    expect(every).toHaveLength(RECORD_SOURCES.length * RECORD_MODES.length);
    for (const source of RECORD_SOURCES) {
      for (const mode of RECORD_MODES) {
        expect(every).toContain(recordSetting(source, mode));
      }
    }
  });

  it('lists both headlines', () => {
    expect(everyRecordLabel()).toEqual(['Record Audio', 'Recording']);
  });

  it('has a mark for every source and every voice count', () => {
    for (const source of RECORD_SOURCES) expect(SOURCE_GLYPH[source]).toContain('<svg');
    for (const mode of RECORD_MODES) expect(VOICES_GLYPH[mode]).toContain('<svg');
    // The two voice marks differ — one head against two is the whole signal
    // at the widths where the words are gone.
    expect(VOICES_GLYPH.solo).not.toBe(VOICES_GLYPH.conversation);
  });
});
