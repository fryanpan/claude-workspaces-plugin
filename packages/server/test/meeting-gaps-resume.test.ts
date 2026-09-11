/**
 * The outages a RESUMED leg has to work out for itself.
 *
 * `meeting-gaps.test.ts` covers an outage inside one unbroken recording. This
 * file covers the one that crossed a reconnect, which is a different problem
 * with a different answer: a meeting picked up again after its socket dropped
 * appends a continuation block, and `flushRawSegments` has to decide which of
 * the meeting's outages belong to it. Those decisions had no test at all —
 * all three could be deleted with the whole server suite green — which is why
 * they have a file rather than a corner of one.
 *
 * All fixtures are synthetic; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawTranscriptPath, readMeetingJson } from '../src/meeting-raw.ts';
import { MeetingStore, listMeetings, meetingIndexPath } from '../src/meetings.ts';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-gaps-resume-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Why the timestamps here are the fixture rather than an incidental.
 *
 * THE TIMESTAMPS ARE THE FIXTURE, not an incidental: every case here is about
 * which SIDE of the restart a gap fell on. `recordGap` reads `Date.now()` with
 * no way in, so the gap lines go onto the append-only index directly, in the
 * shape `recordGap` writes, at times this test picked; `start` and `resume`
 * take the same clock. `stop()` is the one that cannot, and it stamps the
 * real now — which would leave the first leg ending five minutes AFTER the
 * resume that follows it, a meeting no reconnect could produce. The index is
 * append-only and last-write-wins, so the correction is one more line.
 */
describe('the outages a resumed leg has to work out for itself', () => {
  // One arithmetic, entirely in the past, so that the real `stop()` closing
  // the SECOND leg lands after every event the fixture places.
  const T0 = Date.now();
  const STARTED = T0 - 600_000;
  const ENDED_ONE = T0 - 250_000;
  const RESUMED = T0 - 200_000;

  /** A line on the meeting index, in the shape the server appends them. */
  function writeIndexLine(dir: string, meetingId: string, row: Record<string, unknown>): void {
    appendFileSync(meetingIndexPath(dir, 'd1'), `${JSON.stringify({ meetingId, ...row })}\n`);
  }

  /**
   * The leg before the socket dropped: one turn, so there is a transcript file
   * to resume onto, and whatever outages it is meant to have carried.
   */
  function firstLeg(dir: string, outages: Array<Record<string, unknown>> = []) {
    const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Weekly sync' }) });
    const meeting = store.start({
      docId: 'd1',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      now: STARTED,
    });
    if (!meeting) throw new Error('the doc was already recording');
    meeting.recordTurn(0, 'Before the socket dropped.');
    const meetingId = meeting.meetingId;
    for (const row of outages) writeIndexLine(dir, meetingId, row);
    meeting.stop();
    writeIndexLine(dir, meetingId, { endedAt: ENDED_ONE });
    // The fixture's own premise, checked rather than trusted: the correction
    // above only works because the index is read in order and last-write-wins,
    // and every case below is meaningless if the first leg still ends after
    // the resume that follows it.
    const ended = listMeetings(dir, 'd1').find((m) => m.meetingId === meetingId)?.endedAt;
    if (ended !== ENDED_ONE) throw new Error(`the first leg ended at ${ended}, not ${ENDED_ONE}`);
    return { store, meetingId };
  }

  /** Pick the meeting up again, on the same clock. */
  function secondLeg(store: MeetingStore, meetingId: string) {
    const again = store.resume({
      docId: 'd1',
      meetingId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      now: RESUMED,
    });
    if (!again) throw new Error('the resume was refused');
    return again;
  }

  const transcript = (dir: string) =>
    readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');

  it('writes a turnless leg’s outage to the index the record is folded from', () => {
    // The meeting a gap matters most on: the capture was dead for the whole
    // leg, which is WHY there are no turns. The index update used to sit past
    // the early return that the turn count alone decided.
    const dir = dataDir();
    const { store, meetingId } = firstLeg(dir);
    writeIndexLine(dir, meetingId, {
      gapStream: 'mic',
      gapFrom: RESUMED + 1_000,
      gapReason: 'ended',
    });
    secondLeg(store, meetingId).stop();

    const seg = readMeetingJson(dir, 'd1')?.segments.find((s) => s.meetingId === meetingId);
    expect(seg?.gaps?.map((g) => g.stream)).toEqual(['mic']);
    expect(seg?.gaps?.[0]?.to).toBeNull();
  });

  it('appends a continuation block for a leg whose only news is the outage', () => {
    const dir = dataDir();
    const { store, meetingId } = firstLeg(dir);
    writeIndexLine(dir, meetingId, {
      gapStream: 'mic',
      gapFrom: RESUMED + 1_000,
      gapReason: 'ended',
    });
    secondLeg(store, meetingId).stop();

    expect(transcript(dir)).toContain('the microphone stopped here and did not come back');
  });

  it('states the recovery the block before the restart could not know about', () => {
    // That block reported the loss as still open, because it was, and an
    // append-only file cannot go back and add the ending.
    const dir = dataDir();
    const { store, meetingId } = firstLeg(dir, [
      { gapStream: 'system', gapFrom: STARTED + 10_000, gapReason: 'ended' },
    ]);
    const again = secondLeg(store, meetingId);
    writeIndexLine(dir, meetingId, { gapStream: 'system', gapTo: RESUMED + 30_000 });
    again.recordTurn(1, 'Are we back?');
    again.stop();

    expect(transcript(dir)).toContain(
      'the loss it ends is the one the block above reports as still open',
    );
  });

  it('reports an outage wholly inside the resumed leg as its own loss, once', () => {
    // Both halves of this one happened after the reconnect, so the block above
    // knows nothing about it. Counted as carried it would ALSO be printed as
    // the ending of a loss that block reports as still open — a sentence about
    // a claim nobody made.
    const dir = dataDir();
    const { store, meetingId } = firstLeg(dir);
    const again = secondLeg(store, meetingId);
    writeIndexLine(dir, meetingId, {
      gapStream: 'system',
      gapFrom: RESUMED + 10_000,
      gapReason: 'ended',
    });
    writeIndexLine(dir, meetingId, { gapStream: 'system', gapTo: RESUMED + 40_000 });
    again.recordTurn(1, 'Back in the room.');
    again.stop();

    const text = transcript(dir);
    expect(text).toContain('nothing from it was recorded');
    expect(text).not.toContain('the loss it ends is the one the block above reports as still open');
  });

  it('does not reprint an outage the block before the restart already closed', () => {
    // Printed twice, one outage reads as two — and the second is a loss the
    // meeting never had.
    const dir = dataDir();
    const { store, meetingId } = firstLeg(dir, [
      { gapStream: 'system', gapFrom: STARTED + 10_000, gapReason: 'ended' },
      { gapStream: 'system', gapTo: STARTED + 70_000 },
    ]);
    const again = secondLeg(store, meetingId);
    again.recordTurn(1, 'Carrying on.');
    again.stop();

    const text = transcript(dir);
    expect(text.split('nothing from it was recorded').length - 1).toBe(1);
    // And it is not restated as a RECOVERY either. An outage that both opened
    // and closed before the restart is wholly the business of the block above;
    // carried into the continuation it becomes a second ending for a loss that
    // already had one.
    expect(text).not.toContain('came back after');
  });
});
