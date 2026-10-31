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
import { describe, expect, it } from 'bun:test';
import {
  LEAD_LINE_MIN_GAP,
  type LeadChatMeetingLine,
  leadLineTurn,
} from '@claude-workspaces/core/lead-chat';
import { LEAD_ECHO_MS, echoOfLead } from '../src/lead-chat/meeting.ts';

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
    expect(echoOfLead(lines, 'the Saltmarsh slipway', 3_000)).toBe(true);
    expect(echoOfLead(lines, 'Yes.', 3_000)).toBe(false);
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
