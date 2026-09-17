import { RECORDING_CONSENT_NOTE } from '@claude-workspaces/core';
import type { CaptureMode, MeetingBotStatus, MeetingStreamId } from '@claude-workspaces/core';
import { describe, expect, it } from 'vitest';
import { type MeetingFeed, createMeetingFeed } from '../src/meeting-feed.ts';
import type { MeetingLiveZone } from '../src/meeting-live-zone.ts';
import type { TranscriptTurn } from '../src/meeting-protocol.ts';
import type { StreamAlarm } from '../src/meeting-stream-health.ts';
import type { StripState } from '../src/meeting-strip.ts';

/** The control a timed-out recording's sentence can carry beside it. */
type MeetingFeedAction = { label: string; busy: boolean; press(): void };

/**
 * The transcript feed drives one line, and every state a meeting can be left
 * in has to arrive in it as either words or a sentence. These drive
 * `createMeetingFeed` directly — no socket, no strip — because the module's
 * whole contract is "given this state and these turns, what is on the line".
 */

/** A feed wired to mutable holders, so a test moves the state the way the
 *  strip's `let`s move under a rendered line. */
function makeFeed(over: Partial<Harness> = {}): Harness {
  const line = document.createElement('div');
  const h: Harness = {
    line,
    state: { kind: 'idle' } as StripState,
    turns: [] as TranscriptTurn[],
    mode: 'conversation' as CaptureMode,
    startNote: '' as string,
    standingNote: '' as string,
    alarm: null as StreamAlarm | null,
    restoredLine: '' as string,
    reopened: [] as MeetingStreamId[],
    names: {} as Record<string, string>,
    liveBot: null as MeetingBotStatus | null,
    farewell: null as string | null,
    endedNote: '' as string,
    endedReport: '' as string,
    endedAction: null as MeetingFeedAction | null,
    named: [] as string[],
    dismissed: 0,
    endedDismissed: 0,
    liveZone: undefined as MeetingLiveZone | undefined,
    feed: undefined as unknown as MeetingFeed,
    ...over,
  };
  h.feed = createMeetingFeed({
    line: h.line,
    ...(h.liveZone ? { liveZone: h.liveZone } : {}),
    state: () => h.state,
    turns: () => h.turns,
    mode: () => h.mode,
    startNote: () => h.startNote,
    standingNote: () => h.standingNote,
    streamAlarm: () => h.alarm,
    restoredLine: () => h.restoredLine,
    reopenStream: (stream) => h.reopened.push(stream),
    names: () => h.names,
    liveBot: () => h.liveBot,
    botFarewell: () => h.farewell,
    endedNote: () => h.endedNote,
    endedReport: () => h.endedReport,
    endedAction: () => h.endedAction,
    nameSpeaker: (label) => h.named.push(label),
    dismissBotNote: () => {
      h.dismissed += 1;
    },
    dismissEndedNote: () => {
      h.endedDismissed += 1;
    },
  });
  return h;
}

interface Harness {
  line: HTMLElement;
  state: StripState;
  turns: TranscriptTurn[];
  mode: CaptureMode;
  startNote: string;
  standingNote: string;
  alarm: StreamAlarm | null;
  restoredLine: string;
  reopened: MeetingStreamId[];
  names: Record<string, string>;
  liveBot: MeetingBotStatus | null;
  farewell: string | null;
  endedNote: string;
  endedReport: string;
  endedAction: MeetingFeedAction | null;
  named: string[];
  dismissed: number;
  endedDismissed: number;
  liveZone: MeetingLiveZone | undefined;
  feed: MeetingFeed;
}

const words = (line: HTMLElement) =>
  [...line.querySelectorAll('.w')].map((el) => el.textContent?.trim() ?? '');

const pills = (line: HTMLElement) =>
  [...line.querySelectorAll('.meeting-speaker-pill')].map((el) => el.textContent ?? '');

const botStatus = (over: Partial<MeetingBotStatus> = {}): MeetingBotStatus => ({
  botId: 'bot-1',
  docId: 'doc-1',
  state: 'recording',
  meetingUrl: 'https://meet.example.test/abc',
  platform: null,
  speakers: [],
  updatedAt: 0,
  ...over,
});

describe('createMeetingFeed — words on the line', () => {
  it('renders one word span per word, with the speaker tag ahead of them', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'meet on Thursday', final: false, speaker: 'A' }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['meet', 'on', 'Thursday']);
    expect(pills(h.line)).toEqual(['Speaker A']);
  });

  it('rewrites only the corrected word, in place and without a flash', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'meet on thirsty', final: false }];
    h.feed.renderFeed();
    const before = [...h.line.querySelectorAll('.w')];
    h.turns = [{ turn: 1, text: 'meet on Thursday', final: true }];
    h.feed.renderFeed();
    const after = [...h.line.querySelectorAll('.w')];
    // The same elements: a correction lands on the words already on screen.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(words(h.line)).toEqual(['meet', 'on', 'Thursday']);
    // Calm by default: the corrected word is marked with nothing that draws the eye.
    expect(after.some((el) => el.classList.contains('is-fixed'))).toBe(false);
  });

  it('drops the span of a turn that has rolled out of the window', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [
      { turn: 1, text: 'one', final: true },
      { turn: 2, text: 'two', final: false },
    ];
    h.feed.renderFeed();
    expect(h.line.querySelectorAll('.meeting-turn').length).toBe(2);
    h.turns = [{ turn: 2, text: 'two', final: false }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['two']);
  });

  it('hands a tap on a speaker tag straight back to the strip', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'hello', final: false, speaker: 'B' }];
    h.feed.renderFeed();
    const tag = h.line.querySelector<HTMLButtonElement>('button.meeting-speaker');
    tag?.click();
    expect(h.named).toEqual(['B']);
  });

  it('gives a bot turn a tag with no tap in it', () => {
    const h = makeFeed();
    h.state = { kind: 'idle' };
    h.liveBot = botStatus({ speakers: ['Dana'] });
    h.turns = [{ turn: 1, text: 'hello', final: false, speaker: 'Dana' }];
    h.feed.renderFeed();
    expect(h.line.querySelector('button.meeting-speaker')).toBeNull();
    expect(h.line.querySelector('.meeting-speaker.is-fixed')).not.toBeNull();
  });

  it('retags every turn wearing a label once that voice has a name', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [
      { turn: 1, text: 'hi', final: true, speaker: 'A' },
      { turn: 2, text: 'there', final: false, speaker: 'A' },
    ];
    h.feed.renderFeed();
    expect(pills(h.line)).toEqual(['Speaker A', 'Speaker A']);
    h.names = { A: 'Bryan' };
    h.feed.retagSpeaker('A');
    expect(pills(h.line)).toEqual(['Bryan', 'Bryan']);
  });

  it('renders no turns at all when the doc has a live zone', () => {
    const zone = { active: () => true } as unknown as MeetingLiveZone;
    const h = makeFeed({ liveZone: zone });
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'said in two places', final: false }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual([]);
  });
});

describe('createMeetingFeed — the notes that stand in for words', () => {
  it('opens a conversation recording with the consent note', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')?.textContent).toBe(RECORDING_CONSENT_NOTE);
  });

  it('gives a solo recording no consent note — nobody was there to ask', () => {
    const h = makeFeed();
    h.mode = 'solo';
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).toBeNull();
  });

  it('clears the note the moment there are words to show instead', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).not.toBeNull();
    h.turns = [{ turn: 1, text: 'first words', final: false }];
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).toBeNull();
    expect(words(h.line)).toEqual(['first', 'words']);
  });

  it('narrates a live bot that has not said anything yet, naming its speakers', () => {
    const h = makeFeed();
    h.liveBot = botStatus({ state: 'joining', speakers: ['Dana', 'Sam'] });
    h.feed.renderFeed();
    const note = h.line.querySelector('.meeting-bot-note');
    expect(note?.textContent).toContain('Dana, Sam');
  });

  it('offers a terminal bot state as one line the person can tap away', () => {
    const h = makeFeed();
    h.farewell = 'The bot left the call';
    h.feed.renderFeed();
    const note = h.line.querySelector<HTMLButtonElement>('button.meeting-note-dismiss');
    expect(note?.textContent).toBe('The bot left the call');
    note?.click();
    expect(h.dismissed).toBe(1);
  });

  /**
   * The one note here about a meeting that is already over. An idle strip is
   * exactly where it has to render: the recording ended itself, so there is
   * no live state left to hang the explanation on.
   */
  it('carries the timed-out recording’s sentence on an idle line, tappable away', () => {
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.feed.renderFeed();
    const note = h.line.querySelector<HTMLButtonElement>('button.meeting-note-dismiss');
    expect(note?.textContent).toBe('Recording stopped after 15 minutes without speech.');
    note?.click();
    expect(h.endedDismissed).toBe(1);
  });

  /**
   * The offer beside that sentence. It is a SIBLING of the dismiss button,
   * never a child: a control nested inside a button is neither valid markup
   * nor reachable, and a tap meant for the offer would dismiss the line.
   */
  it('draws the tidy-up beside the sentence rather than inside it', () => {
    const presses: number[] = [];
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.endedAction = { label: 'Tidy up the notes', busy: false, press: () => presses.push(1) };
    h.feed.renderFeed();
    const note = h.line.querySelector<HTMLButtonElement>('button.meeting-note-dismiss');
    const act = h.line.querySelector<HTMLButtonElement>('button.meeting-note-tidy');
    expect(act?.textContent).toBe('Tidy up the notes');
    expect(note?.contains(act as Node)).toBe(false);
    act?.click();
    expect(presses).toEqual([1]);
    // Pressing the offer is not dismissing the line.
    expect(h.endedDismissed).toBe(0);
  });

  it('shows the pass as running and refuses the control while it is', () => {
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.endedAction = { label: 'Tidying up these notes…', busy: true, press: () => {} };
    h.feed.renderFeed();
    const act = h.line.querySelector<HTMLButtonElement>('button.meeting-note-tidy');
    expect(act?.textContent).toBe('Tidying up these notes…');
    expect(act?.disabled).toBe(true);
  });

  /**
   * BOTH FACTS, NOT ONE. The report used to arrive as `endedNote` and so
   * overwrote it — spending the one piece of news a returning reader came
   * back for on how a pass they had just pressed went.
   */
  it('keeps the ending sentence when a tidy-up reports beside it', () => {
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.endedReport = 'The tidy-up could not run — this server has no model key configured.';
    h.feed.renderFeed();
    const note = h.line.querySelector<HTMLButtonElement>('button.meeting-note-dismiss');
    const said = h.line.querySelector<HTMLElement>('.meeting-note-report');
    expect(note?.textContent).toBe('Recording stopped after 15 minutes without speech.');
    expect(said?.textContent).toBe(
      'The tidy-up could not run — this server has no model key configured.',
    );
    // The report is a readout, not a second tap target: the sentence beside
    // it already dismisses the whole line.
    expect(said?.tagName).toBe('SPAN');
    // And it comes after the sentence, not before it.
    const kids = [...h.line.children];
    expect(kids.indexOf(said as Element)).toBeGreaterThan(kids.indexOf(note as Element));
  });

  it('draws nothing extra before a press has reported', () => {
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.endedAction = { label: 'Tidy up the notes', busy: false, press: () => {} };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note-report')).toBe(null);
  });

  it('draws no control when there is nothing to offer', () => {
    const h = makeFeed();
    h.endedNote = 'Recording stopped after 15 minutes without speech.';
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note-tidy')).toBe(null);
  });

  it('leaves an idle line with nothing to say empty', () => {
    const h = makeFeed();
    h.line.append(document.createElement('span'));
    h.feed.renderFeed();
    expect(h.line.childNodes.length).toBe(0);
  });

  it('replaces the line with one sentence for showNote', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'words', final: false }];
    h.feed.renderFeed();
    h.feed.showNote('The microphone was refused.', 'meeting-consent-note');
    expect(words(h.line)).toEqual([]);
    const note = h.line.querySelector('.meeting-note');
    expect(note?.textContent).toBe('The microphone was refused.');
    expect(note?.classList.contains('meeting-consent-note')).toBe(true);
  });

  it('leaves the line untouched while a start is still being requested', () => {
    const h = makeFeed();
    h.feed.showNote('Asking for the microphone…');
    h.state = { kind: 'requesting' };
    h.turns = [{ turn: 1, text: 'ignored', final: false }];
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')?.textContent).toBe('Asking for the microphone…');
  });

  it('forgets its spans on clearTurnSpans, so the next turn starts clean', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'one two', final: false }];
    h.feed.renderFeed();
    h.feed.clearTurnSpans();
    expect(h.line.childNodes.length).toBe(0);
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['one', 'two']);
  });
});
