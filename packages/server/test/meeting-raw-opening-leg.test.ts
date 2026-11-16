/**
 * A meeting whose opening leg settled nothing still reads as a meeting with
 * words in its raw transcript.
 *
 * The bug: the lead chat moves the page to the notes doc as soon as the first
 * `ready` arrives, and the page move closes the socket. That first leg stops
 * before anybody has finished a sentence, and its stop wrote the meeting's
 * `## Segment 1` block as `_(no settled turns)_`. Every later leg is a resume,
 * appended below as a `(resumed)` block — but the file is append-only, so the
 * first thing a reader saw said nobody spoke in a meeting holding every turn.
 *
 * All fixtures are synthetic; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMeetingJson } from '../src/meeting-raw.ts';
import { MeetingStore, meetingDirPath } from '../src/meetings.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rawOf(dir: string, docId: string): string {
  const folder = meetingDirPath(dir, docId);
  const file = readdirSync(folder).find((f) => f.endsWith('-raw-transcript.md'));
  return file ? readFileSync(join(folder, file), 'utf8') : '';
}

describe('a meeting whose first leg ended before anybody spoke', () => {
  it('never says "no settled turns" once its turns are recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-raw-leg-'));
    dirs.push(dir);
    const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Harborlight sync' }) });
    const first = store.start({ docId: 'd1', engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    if (!first) throw new Error('the doc was already recording');
    const id = first.meetingId;
    first.stop();
    for (const words of ['Riverbend ferry starts Monday.', 'Saltmarsh slipway is next.']) {
      const leg = store.resume({
        docId: 'd1',
        meetingId: id,
        engine: 'mock',
        sampleRate: 16_000,
        mode: 'solo',
      });
      if (!leg) throw new Error('the resume was refused');
      leg.recordTurn(leg.turnBase, words);
      leg.stop();
    }
    const raw = rawOf(dir, 'd1');
    expect(raw).toContain('Riverbend ferry starts Monday.');
    expect(raw).toContain('Saltmarsh slipway is next.');
    expect(raw).not.toContain('_(no settled turns)_');
    // One segment for one recording, and the first block names its start.
    expect(raw.match(/^## Segment 1 — /gm)).toHaveLength(1);
    expect(readMeetingJson(dir, 'd1')?.segments).toHaveLength(1);
  });

  it('writes nothing for a meeting that has settled nothing yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-raw-leg-'));
    dirs.push(dir);
    const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Harborlight sync' }) });
    const first = store.start({ docId: 'd1', engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    if (!first) throw new Error('the doc was already recording');
    first.stop();
    expect(rawOf(dir, 'd1')).not.toContain('_(no settled turns)_');
    expect(readMeetingJson(dir, 'd1')?.segments).toHaveLength(1);
  });
});
