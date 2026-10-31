/**
 * Two guards on the lines the board's lead says into a meeting.
 *
 * `echoOfLead`: the room's microphone hears the lead's voice played in the
 * room and the transcriber settles it as a room line. Unfiltered, the lead
 * would be fed its own words as the room's (a Mac-audio meeting records the
 * machine's output with no echo cancellation at all). A room line whose words
 * equal, or are a part of, a lead line said in the last `LEAD_ECHO_MS` is
 * the echo; anything else, or anything later, is the room.
 *
 * `leadLineTurn`: each lead line halves the gap before the room's next turn.
 * Unbounded, about fifty lines in a row round onto that whole number and
 * replace the room's line; it stops at `LEAD_LINE_MIN_GAP`.
 *
 * Times are plain numbers passed in: no clock is read.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_LINE_MIN_GAP,
  type LeadChatMeetingLine,
  leadLineTurn,
} from '@claude-workspaces/core/lead-chat';
import {
  LEAD_ECHO_MS,
  LeadChatMeetings,
  type MeetingStart,
  echoOfLead,
} from '../src/lead-chat/meeting.ts';

const said = (text: string, ts: number): LeadChatMeetingLine => ({
  turn: 3.5,
  who: 'Harborlight Lead',
  text,
  ts,
  lead: true,
});

describe('the lead’s own voice heard back', () => {
  const lines = [
    { turn: 3, who: 'Alice', text: 'The slipway needs pricing.', ts: 1_000 },
    said('Who is the Saltmarsh slipway for?', 2_000),
  ];

  it('is the same words, whatever the case and punctuation', () => {
    expect(echoOfLead(lines, 'who is the saltmarsh slipway for', 3_000)).toBe(true);
    expect(echoOfLead(lines, 'Who is the Saltmarsh slipway, for?!', 3_000)).toBe(true);
  });

  it('is a part of the lead’s line long enough not to be a reply', () => {
    expect(echoOfLead(lines, 'is the Saltmarsh slipway for', 3_000)).toBe(true);
    expect(echoOfLead(lines, 'Yes.', 3_000)).toBe(false);
  });

  it('is not a reply that picks up a few of the lead’s words', () => {
    const asked = [said('Who is the slipway pricing for?', 2_000)];
    // Three of the lead's six words: Alice answering, not the echo.
    expect(echoOfLead(asked, 'The slipway pricing', 3_000)).toBe(false);
    expect(echoOfLead(asked, 'the slipway pricing for', 3_000)).toBe(true);
    // Nor the middle of a word.
    expect(echoOfLead(asked, 'ho is the slipway pricing fo', 3_000)).toBe(false);
  });

  it('is not the room answering, nor a room line repeating an old lead line', () => {
    expect(echoOfLead(lines, 'It is for Riverbend.', 3_000)).toBe(false);
    expect(echoOfLead(lines, 'Who is the Saltmarsh slipway for?', 2_000 + LEAD_ECHO_MS)).toBe(true);
    expect(echoOfLead(lines, 'Who is the Saltmarsh slipway for?', 2_001 + LEAD_ECHO_MS)).toBe(
      false,
    );
    // A room line is never taken for an echo of another room line.
    expect(echoOfLead(lines, 'The slipway needs pricing.', 1_500)).toBe(false);
  });
});

describe('which meetings drop the echo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-meeting-echo-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const meetingOf = (source: MeetingStart['source']) => {
    const meetings = new LeadChatMeetings({
      dataDir: join(dir, String(n++)),
      broadcast: () => {},
      newId: () => `lcm-${n}`,
      now: () => 5_000,
    });
    const started = meetings.start('w-harbor', {
      by: { id: 'known-alice', name: 'Alice' },
      docId: 'saltmarsh-plan',
      docTitle: 'Saltmarsh plan',
      notes: 'existing',
      source,
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    if (!started.ok) throw new Error(started.error);
    expect(
      meetings.said('w-harbor', 'Harborlight Lead', 'Who is the slipway pricing for?').ok,
    ).toBe(true);
    const heard = (turn: number, text: string) =>
      meetings.line('w-harbor', started.meeting.id, { turn, who: 'Alice', text });
    return heard;
  };

  it('drops it in a microphone meeting, the only one that plays the lead aloud', () => {
    const heard = meetingOf('mic');
    expect(heard(1, 'who is the slipway pricing for')).toMatchObject({ ok: true, echo: true });
    // Alice's reply that picks up three of its words is kept.
    expect(heard(2, 'The slipway pricing')).toMatchObject({ ok: true, fresh: true });
  });

  it('keeps every line in a Mac-audio or bot meeting, where nothing plays it', () => {
    for (const source of ['mix', 'bot'] as const) {
      const heard = meetingOf(source);
      const r = heard(1, 'who is the slipway pricing for');
      expect(r, source).toMatchObject({ ok: true, fresh: true });
      expect('echo' in r, source).toBe(false);
    }
  });
});

describe('the turn a lead line takes', () => {
  it('sits between the last line and the room’s next turn, and stops before reaching it', () => {
    const lines: LeadChatMeetingLine[] = [{ turn: 3, who: 'Alice', text: 'Go.', ts: 1 }];
    let n = 0;
    for (let t = leadLineTurn(lines); t !== null; t = leadLineTurn(lines)) {
      expect(t).toBeGreaterThan(3);
      expect(t).toBeLessThan(4);
      lines.push({ ...said(`line ${n}`, n), turn: t });
      n++;
      expect(n).toBeLessThan(60);
    }
    expect(n).toBe(10);
    const top = Math.max(...lines.map((l) => l.turn));
    expect(4 - top).toBeGreaterThanOrEqual(LEAD_LINE_MIN_GAP);
  });
});
