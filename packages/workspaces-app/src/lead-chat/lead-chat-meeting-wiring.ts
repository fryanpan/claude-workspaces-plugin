import { makeGestureContext } from '../meeting-audio.ts';
/**
 * What the lead chat's meeting controls do on a page: Start a meeting opens
 * the wizard, its Start mints the notes doc when one is new and starts the
 * board's meeting, End meeting ends it from any page, and the page that
 * holds the microphone picks the recording up again on every load.
 *
 * The decisions that keep a page move cheap live here:
 *   - The browser tab that started the meeting is its recorder
 *     (`recorderToken`), so the next page in that tab resumes the recording
 *     on load, with no tap where the browser allows it. Every other page only
 *     shows the notes.
 *   - A page going away releases the microphone without ending anything.
 *   - A meeting ended elsewhere stops the recording here.
 *   - A tap anywhere on the page is the tap a resumed iPad page waits for.
 *   - The panel that was open when the page went is open on the next one,
 *     while a meeting runs, so the notes stay in view across moves.
 */
import { createMeetingBotClient } from '../meeting-bot-client.ts';
import { systemAudioOffered } from '../meeting-source.ts';
import type { VoiceContext } from '../voice-capture.ts';
import type { LeadChatClient } from './lead-chat-client.ts';
import type { MeetingViewModel } from './lead-chat-meeting-view.ts';
import {
  type LeadLineVoiceOpts,
  createLeadLineVoice,
  leadLinePlaysHere,
} from './lead-chat-meeting-voice.ts';
import {
  type LeadMeetingRun,
  type LeadMeetingRunOpts,
  createLeadMeetingRun,
  recorderToken,
} from './lead-chat-meeting.ts';
import type { LeadChatView } from './lead-chat-view.ts';
import {
  type Wizard,
  type WizardChoice,
  type WizardDoc,
  createWizard,
} from './lead-chat-wizard.ts';

/** In the tab's session storage while the chat's panel is open, so the next
 *  page opens it again (`lead-chat-mount.ts` keeps it, meeting or not). */
export const PANE_OPEN_KEY = 'cw.lead-chat.open';

export interface LeadMeetingSeams
  extends Partial<Omit<LeadMeetingRunOpts, 'workspaceId' | 'author' | 'client' | 'recorder'>> {
  /** The board's docs, for the wizard's picker. */
  loadDocs?: () => Promise<WizardDoc[]>;
  /** Mint a notes doc on the board; answers its id. */
  newDoc?: (topic: string) => Promise<string | null>;
  macAudio?: boolean;
  today?: Date;
  /** How a line the lead says is fetched and played; injected by tests. */
  leadVoice?: Partial<Pick<LeadLineVoiceOpts, 'fetch' | 'playbackContext'>>;
}

export interface LeadMeetingWiringOpts {
  document: Document;
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  client: LeadChatClient;
  view: LeadChatView;
  getContext?: () => VoiceContext | undefined;
  /** Per tab: the recorder token. */
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  seams?: LeadMeetingSeams;
  /** Something the panel draws changed. */
  changed: () => void;
  /** Open the panel, as a page that resumes a meeting does. */
  openPane: () => void;
  /** A one-line notice under the chat. */
  notice: (text: string) => void;
}

export interface LeadMeetingWiring {
  run: LeadMeetingRun;
  wizard: Wizard;
  model(): MeetingViewModel | undefined;
  /** Call on every client change. */
  sync(): void;
  destroy(): void;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch = (): Fetch => (u, i) => fetch(u, i);

export function boardDocsLoader(workspaceId: string, doFetch: Fetch = defaultFetch()) {
  return async (): Promise<WizardDoc[]> => {
    const res = await doFetch(`/workspaces/${encodeURIComponent(workspaceId)}/library/items`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      meetings?: Array<{ name: string; href?: string; at?: number }>;
      files?: Array<{ name: string; href?: string; at?: number }>;
    };
    const docs: Array<WizardDoc & { at: number }> = [];
    for (const r of [...(body.meetings ?? []), ...(body.files ?? [])]) {
      const m = r.href?.match(/\/docs\/([^/?#]+)$/);
      if (m?.[1]) docs.push({ docId: decodeURIComponent(m[1]), title: r.name, at: r.at ?? 0 });
    }
    docs.sort((a, b) => b.at - a.at);
    return docs.map(({ docId, title }) => ({ docId, title }));
  };
}

export function boardDocMinter(workspaceId: string, doFetch: Fetch = defaultFetch()) {
  return async (topic: string): Promise<string | null> => {
    const res = await doFetch(`/workspaces/${encodeURIComponent(workspaceId)}/huddles`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'discussion', topic }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { docId?: string };
    return body.docId ?? null;
  };
}

export function wireLeadMeeting(opts: LeadMeetingWiringOpts): LeadMeetingWiring {
  const { document: doc, client, view, author } = opts;
  const win = doc.defaultView ?? window;
  const seams = opts.seams ?? {};
  const recorder = recorderToken(opts.session);
  let ending = false;
  /** The meeting this page has already tried to resume, or joined. */
  let resumed = '';
  let joined = '';

  const run = createLeadMeetingRun({
    bot: (docId) => createMeetingBotClient({ docId }),
    ...seams,
    workspaceId: opts.workspaceId,
    author,
    client,
    recorder,
    onChange: (s) => {
      seams.onChange?.(s);
      opts.changed();
    },
  });

  // What the lead says into the meeting, played here when this tab holds
  // the microphone (`lead-chat-meeting-voice.ts`).
  let playing: { meetingId: string; turn: number } | null = null;
  /** Per meeting, the lead's lines played here to their end. */
  const said = new Map<string, Set<number>>();
  const leadVoice = createLeadLineVoice({
    ...seams.leadVoice,
    workspaceId: opts.workspaceId,
    author,
    onPlaying: (meetingId, turn) => {
      playing = { meetingId, turn };
      opts.changed();
    },
    onDone: (meetingId, turn, done) => {
      if (playing?.meetingId === meetingId && playing.turn === turn) playing = null;
      if (done) {
        const s = said.get(meetingId) ?? new Set<number>();
        s.add(turn);
        said.set(meetingId, s);
      }
      opts.changed();
    },
  });
  client.onLeadLine((meetingId, line) => {
    const m = client.state().meeting;
    if (!m || m.id !== meetingId || !leadLinePlaysHere(m, recorder)) return;
    leadVoice.play(meetingId, line.turn);
  });

  const failStart = (why: string): void => {
    opts.notice(
      why === 'meeting-running'
        ? 'A meeting is already running on this board.'
        : 'The meeting did not start. Check the connection and try again.',
    );
  };

  const onStart = (choice: WizardChoice): void => {
    // Inside the tap, before anything is awaited: Safari starts an audio
    // context only here.
    const context =
      choice.source === 'bot' ? undefined : (seams.createAudioContext ?? makeGestureContext)();
    void (async () => {
      let docId = choice.doc?.docId;
      let docTitle = choice.doc?.title;
      if (choice.notes !== 'existing') {
        // "No notes" still records into a doc of its own, so the transcript
        // has a home; the note-taker writes nothing there.
        docTitle = choice.name || 'Meeting';
        docId = (await (seams.newDoc ?? boardDocMinter(opts.workspaceId))(docTitle)) ?? undefined;
      }
      if (!docId || !docTitle) {
        void context?.close?.().catch(() => {});
        failStart('no-doc');
        return;
      }
      const res = await client.meeting('start', author, {
        docId,
        docTitle,
        notes: choice.notes,
        source: choice.source,
        speakers: choice.speakers,
        recorder,
      });
      if (!res.ok || !res.meeting) {
        void context?.close?.().catch(() => {});
        failStart(res.ok ? 'no-meeting' : res.error);
        return;
      }
      resumed = res.meeting.id;
      joined = res.meeting.id;
      opts.openPane();
      await run.begin(res.meeting, {
        gesture: true,
        ...(context ? { context } : {}),
        ...(choice.botUrl ? { botUrl: choice.botUrl } : {}),
      });
    })();
  };

  const hereDocId = (): string | undefined => {
    const c = opts.getContext?.();
    return c?.surface === 'doc' ? c.docId : undefined;
  };
  const here = hereDocId();
  const wizard = createWizard({
    document: doc,
    root: view.root,
    loadDocs: seams.loadDocs ?? boardDocsLoader(opts.workspaceId),
    ...(here ? { hereDocId: here } : {}),
    macAudio: seams.macAudio ?? systemAudioOffered(),
    ...(seams.today ? { today: seams.today } : {}),
    onStart,
  });

  const onStartTap = (): void => wizard.show();
  const onEnd = async (): Promise<void> => {
    const m = client.state().meeting;
    if (!m || ending) return;
    ending = true;
    opts.changed();
    run.stop();
    await client.meeting('end', author, { id: m.id });
    ending = false;
    opts.changed();
  };
  const onEndTap = (): void => void onEnd();
  const onTap = (): void => run.tap();
  /** Any tap on the page is the gesture a waiting microphone needs. */
  const onPageTap = (): void => {
    if (run.state().phase === 'tap') run.tap();
    leadVoice.wake();
  };
  const onHide = (): void => {
    run.release();
  };

  view.start.addEventListener('click', onStartTap);
  view.meeting.end.addEventListener('click', onEndTap);
  view.meeting.tap.addEventListener('click', onTap);
  doc.addEventListener('click', onPageTap, true);
  win.addEventListener('pagehide', onHide);

  return {
    run,
    wizard,
    model() {
      const meeting = client.state().meeting;
      if (!meeting) return undefined;
      return {
        meeting,
        run: run.state(),
        recording: meeting.recorder === recorder,
        ending,
        playing: playing?.meetingId === meeting.id ? playing.turn : null,
        said: said.get(meeting.id) ?? new Set<number>(),
      };
    },
    sync() {
      const s = client.state();
      const m = s.meeting;
      const phase = run.state().phase;
      if (!m) {
        // Ended, here or on another page.
        if (phase !== 'idle') run.stop();
        return;
      }
      if (m.recorder === recorder && resumed !== m.id && phase === 'idle') {
        resumed = m.id;
        void run.begin(m, { gesture: false });
      }
      if (joined !== m.id && !m.people.some((p) => p.id === author.id)) {
        joined = m.id;
        void client.meeting('join', author, { id: m.id });
      }
    },
    destroy() {
      view.start.removeEventListener('click', onStartTap);
      view.meeting.end.removeEventListener('click', onEndTap);
      view.meeting.tap.removeEventListener('click', onTap);
      doc.removeEventListener('click', onPageTap, true);
      win.removeEventListener('pagehide', onHide);
      wizard.destroy();
      leadVoice.stop();
      run.release();
    },
  };
}
