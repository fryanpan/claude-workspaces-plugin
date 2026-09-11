/**
 * Everything a live meeting needs mounted over a markdown document: the
 * transcript strip along the bottom of the editor pane, the provisional live
 * zone at the end of the prose, the Recall bot client behind the strip's
 * chrome, and the lead banner a huddle doc carries.
 *
 * One function rather than four because they are only ever mounted together
 * and under one condition — an ordinary markdown doc with a strip element,
 * never a diff member's companion view. The mount reads the huddle flag off
 * the address and takes it back out, so it has to run exactly once.
 *
 * It hands back the two things the rest of the mount closes over: the live
 * zone the wash extension asks about, and the lead-presence watch the floats
 * quote in their receipts. Both are absent on a doc that holds no meeting.
 */
import type { User } from '@claude-workspaces/core';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorHandle } from '../editor.ts';
import {
  huddleCaptureMode,
  huddleEngine,
  huddleRoomAudio,
  huddleRoomSpeakers,
  withoutHuddleStart,
} from '../huddle-entry.ts';
import type { LeadBanner } from '../lead-banner.ts';
import { mountLeadBanner } from '../lead-banner.ts';
import { createMeetingBotClient } from '../meeting-bot-client.ts';
import { mountMeetingCleanupOffer } from '../meeting-cleanup-offer.ts';
import { type MeetingLiveZone, createMeetingLiveZone } from '../meeting-live-zone.ts';
import { othersOnDoc } from '../meeting-solo.ts';
import { type MeetingStripHandle, mountMeetingStrip } from '../meeting-strip.ts';
import { wantsLatencyTiming } from '../meeting-timing-client.ts';
import type { MountScope } from '../mount-scope.ts';
import {
  type DocSpeakersCache,
  createDocSpeakersCache,
  loadDocTranscript,
  postSpeakerName,
} from '../speaker-voices.ts';

export interface DocMeetingOptions {
  docId: string;
  /** The strip's own element. The caller already needs it for the keyboard
   *  inset, so it is passed in rather than looked up a second time. */
  stripEl: HTMLElement;
  scope: MountScope;
  editor: EditorHandle;
  editorMount: HTMLElement;
  user: User;
  awareness: Awareness;
  /** True when this entry carried the Board's huddle-start flag. */
  huddleStart: boolean;
  /** True on a huddle doc, which is the only doc that gets a lead banner. */
  huddle: boolean;
}

export interface DocMeetingMount {
  liveZone?: MeetingLiveZone;
  watchLeadPresence?: LeadBanner['watch'];
  /**
   * Name a voice for the whole meeting — the strip's verb, handed up so the
   * notes' own rename entry can use the one channel that knows whether a
   * capture is still running. Absent on a doc that mounts no meeting.
   */
  renameSpeaker?: (label: string, name: string) => Promise<boolean>;
  /**
   * The doc's roster, already loaded for the strip. Handed up so the notes'
   * reassign menu opens on it instead of paying for the same two requests
   * again at the moment of the tap.
   */
  speakers?: DocSpeakersCache;
}

export function mountDocMeeting(opts: DocMeetingOptions): DocMeetingMount {
  const { docId, stripEl, scope, editor, editorMount, user, awareness, huddleStart, huddle } = opts;
  // "Record a conversation" is the only thing that says someone else is in
  // the room, and it is a press on the Board — a page that is gone by the
  // time this mounts. It rides in on the address with the start flag and
  // leaves with it. Left `undefined` outside a huddle start on purpose:
  // this feeds the start chooser's own preselection (`meeting-strip.ts`'s
  // `chooseMode`), and that default is the approved mock's Multiple
  // Speakers, not `DEFAULT_CAPTURE_MODE` — passing the default here always
  // made it look like the address had asked for solo, so the chooser never
  // showed the mock's preselection to anyone who opened a doc directly.
  const huddleMode = huddleStart ? huddleCaptureMode(location.search) : undefined;
  const roomSpeakers = huddleRoomSpeakers(location.search);
  const roomAudio = huddleRoomAudio(location.search);
  // Which engine transcribes here. A preference like `speakers`, not a
  // gesture: read every visit, left on the address.
  const engine = huddleEngine(location.search);
  if (huddleStart) {
    history.replaceState(
      history.state,
      '',
      withoutHuddleStart(location.pathname + location.search + location.hash),
    );
  }
  // Who this doc's last meeting heard, loaded once and shared: the strip
  // asks for it at mount, and the notes' reassign menu opens on the same
  // answer instead of fetching it again under the person's finger.
  const speakers = createDocSpeakersCache(docId);
  // `?timing=1` measures this meeting's stage latencies and shows the
  // running numbers. Left in the address on purpose, unlike the huddle
  // flag: a reload should keep measuring, and it opens no mic by itself —
  // which is also why it is read after the huddle flag has been stripped.
  // The bot's lifecycle is its own client — one endpoint, one SSE event —
  // and the strip's chrome renders it: the invite lives in the start
  // chooser, the state in the strip and menu. It hides itself when the
  // server has no Recall key, so this costs one GET on a doc that cannot
  // use it.
  const botClient = createMeetingBotClient({ docId });
  scope.onCleanup(() => botClient.destroy());
  // The provisional zone at the end of the doc: the live transcript, the
  // splitting-off card, and (via the wash extension declared on the editor
  // above) the settle highlight on each freshly written note.
  // The zone owns the only speaker pills on screen during a capture (the
  // strip renders none while it exists), so it is where a voice is named —
  // and the strip is what knows which channel a name travels on. The two
  // point at each other, so one of them is reached through a holder: the
  // strip, because the zone is built first and the strip takes it as an
  // option.
  const mounted: { strip?: MeetingStripHandle } = {};
  const liveZone = createMeetingLiveZone({
    parent: editorMount,
    prose: editor.editor.view.dom,
    nameSpeaker: (label) => mounted.strip?.nameSpeaker(label),
  });
  const zone = liveZone;
  scope.onCleanup(() => zone.destroy());
  // The offer to read the notes once more, when a recording ends. A modal
  // over the notes it is about — never a row in the prose, which is the shape
  // that left it standing open on docs that had never recorded — and it holds
  // the settle wash open across its request, so the notes a tidy-up writes
  // highlight like every other note of the meeting.
  const cleanupOffer = mountMeetingCleanupOffer({ docId, liveZone: zone });
  scope.onCleanup(() => cleanupOffer.destroy());
  // Nothing here counts the tinted notes any more: the new-content
  // indicator does, off the same editor transaction the margin already
  // listens to (doc-margin.ts), so a note arriving, stepping down or ageing
  // out re-counts without a second listener on this surface.
  // Built outside the call: a source-shape test reads the mount up to its
  // first `})`, and an inline conditional spread would end it early.
  const participant = user.name ? { participantName: user.name } : {};
  const strip = mountMeetingStrip({
    docId,
    root: stripEl,
    // The Record Audio button docks at the end of the top BAR — beside the
    // toolbar, not inside it. The toolbar scrolls sideways on a phone, and a
    // control in a scroll container is a control that can be scrolled out of
    // reach; see `MeetingStripOpts.dock`. The strip fuses to it from the row
    // below.
    dock: document.querySelector<HTMLElement>('#topbar'),
    bot: botClient,
    // "<name>'s Claude Code Agent" — the bot walks into the call wearing
    // the name of the person who sent it, editable in the chooser.
    botNamePrefill: user.name ? `${user.name}'s Claude Code Agent` : 'Claude Code Agent',
    // The same person, on the raw transcript's unlabelled turns.
    ...participant,
    // Which of the two entries this press was, read off the mode it
    // carries: a solo huddle ("Make a plan") opens the microphone, and a
    // conversation ("Have a meeting") opens the chooser instead,
    // because a room cannot be recorded until somebody presses the button
    // that tells it so. Nothing new on the address — the mode the Board
    // already sends is the whole difference between the two buttons.
    autoStart: huddleStart && huddleMode !== 'conversation',
    autoChoose: huddleStart && huddleMode === 'conversation',
    // Alone on the doc, a Record press records at once — solo, default
    // engine, no chooser. Presence is asked at the press, not here: who is
    // on the doc changes, and the answer belongs to the moment of the tap.
    alone: () => othersOnDoc(awareness, user).length === 0,
    // Read BEFORE the flag is stripped from the address above… it is, in
    // fact, read from `location.search` there too, so both come off the
    // same address; see `huddleCaptureMode`.
    mode: huddleMode,
    // Room facts, not gestures: read on every visit — including one where
    // the person flips the strip's own switch — and left on the address.
    ...(roomSpeakers !== undefined ? { speakers: roomSpeakers } : {}),
    ...(roomAudio ? { room: roomAudio } : {}),
    ...(engine !== undefined ? { engine } : {}),
    timing: wantsLatencyTiming(location.search),
    // The rename surface a finished meeting leaves behind: the last
    // meeting's cast on mount, and the HTTP rename for a socket that is
    // gone. Same record the reassign menu below reads.
    loadSpeakers: () => speakers.load(),
    // The cache is keyed by the meeting it came from, and the strip is what
    // knows when the doc moves between meetings — so the menu below cannot
    // go on offering the last meeting's cast as targets for a note being
    // written in this one.
    onMeetingChange: (meetingId) => {
      speakers.meetingChanged(meetingId);
      // A new meeting is starting (`null`) or the doc has moved on: an offer
      // to tidy the last one is no longer the offer to make.
      if (meetingId === null) cleanupOffer.withdraw();
    },
    onMeetingEnded: (meetingId) => cleanupOffer.offer(meetingId),
    // The other record: what the meeting HEARD, behind the panel's fold.
    // Before this it lived only in the `-raw-transcript.md` beside the
    // server's data dir, which is nowhere for anyone not on that machine.
    loadTranscript: () => loadDocTranscript(docId),
    postName: (meetingId, speaker, name) => postSpeakerName({ docId, meetingId, speaker, name }),
    liveZone: zone,
  });
  mounted.strip = strip;
  scope.onCleanup(() => strip.destroy());
  // The standing line for an empty lead seat — huddle docs only, because
  // a huddle is the doc whose every ask addresses that seat (the floats
  // above, the assistant's spoken captures). Sits at the top of the
  // scrolling prose; see lead-banner.ts for what "listening" means.
  let watchLeadPresence: LeadBanner['watch'] | undefined;
  if (huddle) {
    const banner = mountLeadBanner({ docId, parent: editorMount });
    watchLeadPresence = (onChange) => banner.watch(onChange);
    scope.onCleanup(() => banner.destroy());
  }
  return {
    liveZone,
    speakers,
    renameSpeaker: (label, name) => strip.renameSpeaker(label, name),
    ...(watchLeadPresence ? { watchLeadPresence } : {}),
  };
}
