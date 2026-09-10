import { describe, expect, it } from 'vitest';
import {
  type LostStream,
  reopenActionLabel,
  reopensWithoutGesture,
  restoredNote,
  streamAlarm,
} from '../src/meeting-stream-health.ts';

/**
 * What the person is told, and what they are offered. These are the sentences
 * that decide whether somebody stops a recording that is still working, or
 * carries on talking into one that is not — so they are asserted as sentences.
 */

const lost = (over: Partial<LostStream> & Pick<LostStream, 'stream'>): LostStream => ({
  reason: 'ended',
  recovering: false,
  ...over,
});

describe('which streams can come back on their own', () => {
  it('lets the microphone reopen itself and never the share picker', () => {
    // getDisplayMedia is a modal; a browser refuses it without a gesture, and
    // the refusal is a rejected promise nobody sees.
    expect(reopensWithoutGesture('mic')).toBe(true);
    expect(reopensWithoutGesture('system')).toBe(false);
  });
});

describe('the line while a capture is down', () => {
  it('is nothing at all while every capture is delivering', () => {
    expect(streamAlarm({ lost: [], running: ['mic', 'system'] })).toBeNull();
  });

  it('names the stream that stopped, who is lost, and what still records', () => {
    const alarm = streamAlarm({
      lost: [lost({ stream: 'system' })],
      running: ['mic'],
    });
    expect(alarm?.text).toBe(
      "This Mac's audio stopped — voices on the call aren't being recorded. Still recording the microphone.",
    );
  });

  it('offers the press that is the only way back for the Mac’s audio', () => {
    const alarm = streamAlarm({ lost: [lost({ stream: 'system' })], running: ['mic'] });
    expect(alarm?.action).toEqual({
      stream: 'system',
      label: "Share this Mac's audio again",
    });
  });

  it('says it is trying, and offers no button, while a retry is in flight', () => {
    const alarm = streamAlarm({
      lost: [lost({ stream: 'mic', recovering: true })],
      running: ['system'],
    });
    expect(alarm?.text).toContain('Trying to get it back.');
    expect(alarm?.action).toBeUndefined();
  });

  it('stops promising a recovery once the retries have run out', () => {
    // The sentence and the button move together: a line saying "trying" with
    // nothing trying is the same lie as a silent recording.
    const alarm = streamAlarm({
      lost: [lost({ stream: 'mic', recovering: false })],
      running: ['system'],
    });
    expect(alarm?.text).not.toContain('Trying to get it back.');
    expect(alarm?.action).toEqual({ stream: 'mic', label: 'Start the microphone again' });
  });

  it('says nothing is being recorded when the last capture dies', () => {
    const alarm = streamAlarm({ lost: [lost({ stream: 'mic' })], running: [] });
    expect(alarm?.text).toContain('nothing is being recorded');
    expect(alarm?.text).not.toContain('Still recording');
  });

  it('names both when a meeting loses both of its captures', () => {
    const alarm = streamAlarm({
      lost: [lost({ stream: 'mic' }), lost({ stream: 'system' })],
      running: [],
    });
    expect(alarm?.text).toContain("The microphone and this Mac's audio stopped");
    expect(alarm?.text).toContain('nothing is being recorded');
  });
});

describe('the line once it comes back', () => {
  it('names the capture that is recording again', () => {
    expect(restoredNote('system')).toBe("This Mac's audio is recording again.");
    expect(restoredNote('mic')).toBe('The microphone is recording again.');
  });

  it('labels the press for the stream it belongs to', () => {
    expect(reopenActionLabel('system')).toBe("Share this Mac's audio again");
    expect(reopenActionLabel('mic')).toBe('Start the microphone again');
  });
});
