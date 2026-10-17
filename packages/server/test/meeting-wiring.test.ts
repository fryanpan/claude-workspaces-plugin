/**
 * The meetings, wired (meeting-wiring.ts), driven directly.
 *
 * The property the module exists to keep is ORDER: `createServer` calls it
 * before the doc store, the task store and everything else it reaches, so
 * wiring must read none of them. Every late getter here throws, the way a
 * `const` in its temporal dead zone would, and wiring still succeeds.
 *
 * What a meeting then does with those reads runs through the real server in
 * the meeting suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LandingPart } from '../src/landing-changes.ts';
import { type MeetingLateDeps, wireMeetings } from '../src/meeting-wiring.ts';
import { MeetingStore } from '../src/meetings.ts';
import { LeadAnswers } from '../src/spoken-reply/lead-answer.ts';
import { SseBus } from '../src/sse.ts';

let dir: string;
let read: string[];

/** Getters that record and refuse, standing in for values not built yet. */
const unbuilt = (): MeetingLateDeps => {
  const refuse = (name: string) => () => {
    read.push(name);
    throw new ReferenceError(`${name} read during wiring`);
  };
  return {
    docStore: refuse('docStore'),
    taskStore: refuse('taskStore'),
    taskProjection: refuse('taskProjection'),
    mountStore: refuse('mountStore'),
    readyNudger: refuse('readyNudger'),
    spokenBoard: refuse('spokenBoard'),
    planMinutes: refuse('planMinutes'),
    fileUnderBoardWorkspace: refuse('fileUnderBoardWorkspace'),
    backTargetFor: refuse('backTargetFor'),
    fileReviewRequest: refuse('fileReviewRequest'),
    lookupDocs: refuse('lookupDocs'),
  };
};

const wire = (opts = {}, notified: LandingPart[] = []) =>
  wireMeetings({
    dataDir: dir,
    opts,
    sse: new SseBus(),
    notifyLanding: (part) => notified.push(part),
    recallCallbackHost: null,
    proxiedTrustedHosts: [],
    anonymousColor: '#8a8a8a',
    late: unbuilt(),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meeting-wiring-'));
  read = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wireMeetings', () => {
  it('reads nothing built after it while wiring', async () => {
    const meetings = wire();
    expect(read).toEqual([]);
    expect(meetings.meetingStore).toBeInstanceOf(MeetingStore);
    expect(meetings.leadAnswers).toBeInstanceOf(LeadAnswers);
    await meetings.dispose();
    expect(read).toEqual([]);
  });

  it('builds no calendar join unless a calendar bot is configured', async () => {
    const meetings = wire();
    expect(meetings.calendarStore).toBeNull();
    expect(meetings.calendarSync).toBeNull();
    expect(meetings.calendarOauthStates.size).toBe(0);
    await meetings.dispose();
  });

  it('starts with no doc recording, so the doc store it is handed to holds nothing', async () => {
    const meetings = wire();
    expect(meetings.meetingStore.active('any-doc')).toBeUndefined();
    await meetings.dispose();
  });

  it('disposes the three relays and can be disposed with nothing live', async () => {
    const meetings = wire();
    await expect(meetings.dispose()).resolves.toBeUndefined();
  });
});
