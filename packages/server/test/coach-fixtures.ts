/**
 * An invented learning-goals doc and two invented working days for the
 * coach, as the signals its stream hears: views from the pages (with the
 * heading and passage in view), paragraphs he wrote, and activity rows.
 *
 * DRIFTING_DAY wanders three times in ways his goals name: half an hour on
 * a button-hover mock while the launch post is unfinished (goal 1), a
 * partner's message read and left without a reply (goal 2), and an importer
 * designed in a spec that never says why it is needed (goal 3). ON_TRACK_DAY
 * spends the same hours on the launch post, and writes the spec's why first.
 *
 * LABELLED_POINTS name signals in the drifting day by index, with what a
 * good coach does after it, "speak" or "stay quiet". `scripts/coach-eval.ts`
 * plays the day to a real coach session and counts how many it gets right.
 *
 * House names only (Harborlight, Riverbend, Saltmarsh). Agent rows are mixed
 * in so a reader that forgot `isOwner` would see a different day.
 */
import { instantForLocal } from '@claude-workspaces/core/schedule-timezone';
import type { Event } from '../src/activity.ts';
import type { HereSignal } from '../src/coach/stream.ts';

export const ZONE = 'America/Los_Angeles';
export const WS = 'w-harbor';

/** Wednesday 7 October 2026, at `hour:minute` his time. */
export const at = (hour: number, minute = 0): number =>
  instantForLocal(ZONE, 2026, 10, 7, hour, minute);

export const GOALS_DOC = `# Learning goals

## Your coach’s name

Let’s call it Saltmarsh.

## Goal 1

### What I want to do better

Do the hard, important work before the easy polish.

### What’s behind it

The Harborlight launch post slips every week while I tidy styles.

### Act differently when

I spend more than twenty minutes on styling or polish while the launch post is unfinished.

### How

Close the styling page and open the launch post draft.

## Goal 2

### What I want to do better

Answer people who are waiting on me the same day.

### What’s behind it

Riverbend partners wait days for a reply.

### Act differently when

I read a message from someone waiting on me and move on without replying.

### How

Reply in two lines before leaving the page.

## Goal 3

### What I want to do better

Say why a thing matters before deciding how to build it.

### What’s behind it

Riverbend specs grow a design nobody asked for.

### Act differently when

I start on a solution before I have written down why it matters.

### How

Write two lines on the problem and who has it, then the design.
`;

export const DOCS: Record<string, { title: string; board: string; kind: string }> = {
  'd-post': { title: 'Harborlight launch post draft', board: 'Harborlight', kind: 'markdown' },
  'd-hover': { title: 'Button hover states mock', board: 'Harborlight', kind: 'mockup' },
  'd-partner': {
    title: 'Message from a Riverbend partner, waiting on your answer',
    board: 'Riverbend',
    kind: 'markdown',
  },
  'd-tokens': { title: 'Board colour tokens', board: 'Harborlight', kind: 'markdown' },
  'd-booking': { title: 'Riverbend booking flow spec', board: 'Riverbend', kind: 'markdown' },
  'd-saltmarsh': {
    title: 'Question from a Saltmarsh partner, waiting on your answer',
    board: 'Riverbend',
    kind: 'markdown',
  },
};

export const label = (docId: string) => {
  const d = DOCS[docId];
  return d ? { title: d.title, board: d.board } : {};
};

export type Signal = { at: number } & ({ here: Omit<HereSignal, 'at'> } | { row: Event });

function row(
  type: Event['type'],
  docId: string,
  when: number,
  payload: Event['payload'] = {},
  owner = true,
): Signal {
  const d = DOCS[docId];
  return {
    at: when,
    row: {
      eventId: `ev-${docId}-${when}-${type}`,
      ts: new Date(when).toISOString(),
      type,
      actor: owner ? 'person' : 'agent',
      isOwner: owner,
      doc: {
        docId,
        sourceUrl: null,
        relPath: null,
        title: d?.title ?? docId,
        kind: (d?.kind ?? 'markdown') as Event['doc']['kind'],
        repo: { owner: null, name: null, remote: null },
        producedBy: { agentId: null, sessionId: null, cwd: null },
      },
      payload,
    } as unknown as Event,
  };
}

const view = (when: number, docId: string, heading: string, text: string): Signal => ({
  at: when,
  here: { kind: 'view', workspaceId: WS, docId, visible: true, heading, text },
});

const wrote = (when: number, docId: string, heading: string, text: string): Signal => ({
  at: when,
  here: { kind: 'wrote', workspaceId: WS, docId, visible: true, heading, text },
});

const away = (when: number, docId: string): Signal => ({
  at: when,
  here: { kind: 'view', workspaceId: WS, docId, visible: false },
});

const POST_WHY =
  'Harborlight is a booking tool for small marinas. We built it because harbour masters still take bookings on paper.';
const POST_COST =
  'It costs nothing for the first berth. Each berth after that is four dollars a month.';
const HOVER =
  'Hover: shadow 0 2px 6px, lift 1px. Pressed: shadow none, lift 0. Focus: 2px ring in the accent colour.';
const PARTNER =
  'Can we move the launch to the 20th? We need to tell the venue by Friday, so a yes or no today would help.';
const TOKENS = 'grey-50 #f8f9fb, grey-100 #eef1f4, grey-200 #e6e9ed. The warm grey reads as beige.';
const BOOKING = 'Payment step: the guest pays a deposit, and the rest on arrival.';
const SALTMARSH = 'Does the Saltmarsh price hold until December? We sign the contract next week.';

export const DRIFTING_DAY: Signal[] = [
  view(at(9), 'd-post', 'Why we built it', POST_WHY),
  wrote(
    at(9, 12),
    'd-post',
    'Why we built it',
    'The paper books get wet, and a berth is sold twice.',
  ),
  view(at(9, 41), 'd-hover', 'Hover, pressed, focus', HOVER),
  wrote(at(9, 50), 'd-hover', 'Hover, pressed, focus', 'Hover: shadow 0 3px 8px, lift 2px.'),
  row('comment', 'd-hover', at(10, 12), { text: 'Try a softer shadow on hover, and a 2px lift.' }),
  view(at(10, 31), 'd-partner', 'Can we move the launch?', PARTNER),
  view(at(10, 44), 'd-tokens', 'Greys', TOKENS),
  row('edit_session', 'd-booking', at(10, 50), { editCount: 40 }, false),
  away(at(10, 59), 'd-tokens'),
  view(at(11), 'd-booking', 'Payment step', BOOKING),
  wrote(
    at(11, 10),
    'd-booking',
    'Importer',
    'The importer reads the partner CSV, maps each column to a booking field, and queues a retry for any row that fails.',
  ),
  away(at(11, 41), 'd-booking'),
  view(at(13), 'd-post', 'What it costs', POST_COST),
  wrote(at(13, 20), 'd-post', 'What it costs', 'Berths for boats under six metres are free.'),
  view(at(13, 31), 'd-saltmarsh', 'Pricing question', SALTMARSH),
  row('reply', 'd-saltmarsh', at(13, 48), {
    text: 'Yes, the Saltmarsh price holds until December.',
  }),
  away(at(13, 50), 'd-saltmarsh'),
];

export const ON_TRACK_DAY: Signal[] = [
  view(at(9), 'd-post', 'Why we built it', POST_WHY),
  wrote(
    at(9, 12),
    'd-post',
    'Why we built it',
    'The paper books get wet, and a berth is sold twice.',
  ),
  wrote(at(10, 15), 'd-post', 'Who it is for', 'Harbour masters with fewer than forty berths.'),
  away(at(10, 31), 'd-post'),
  view(at(11), 'd-booking', 'Payment step', BOOKING),
  wrote(
    at(11, 10),
    'd-booking',
    'Why an importer',
    'Riverbend partners re-type every booking from their own sheet, and one in twenty has a typo.',
  ),
  wrote(
    at(11, 25),
    'd-booking',
    'Importer',
    'The importer reads the partner CSV and maps each column to a booking field.',
  ),
  away(at(11, 41), 'd-booking'),
  view(at(13), 'd-post', 'What it costs', POST_COST),
  wrote(at(13, 20), 'd-post', 'What it costs', 'Berths for boats under six metres are free.'),
  away(at(13, 51), 'd-post'),
];

export interface LabelledPoint {
  /** The index in DRIFTING_DAY after which the coach decides. */
  after: number;
  expect: 'speak' | 'quiet';
  /** 0-based, for a "speak" point. */
  goalIndex?: number;
  why: string;
}

export const LABELLED_POINTS: LabelledPoint[] = [
  { after: 1, expect: 'quiet', why: 'writing the launch post itself' },
  { after: 3, expect: 'quiet', why: 'nine minutes on the hover mock: under the twenty he named' },
  {
    after: 4,
    expect: 'speak',
    goalIndex: 0,
    why: 'half an hour on hover states, post unfinished',
  },
  {
    after: 6,
    expect: 'speak',
    goalIndex: 1,
    why: 'read the partner’s message and moved on without replying',
  },
  {
    after: 10,
    expect: 'speak',
    goalIndex: 2,
    why: 'designed the importer in a spec that never says why it is needed',
  },
  { after: 13, expect: 'quiet', why: 'back on the launch post' },
  { after: 15, expect: 'quiet', why: 'read the Saltmarsh question and replied' },
];
