/**
 * The board's microphone: where an utterance lands.
 *
 * One responsibility, and it is the anchoring rather than the capture —
 * `voice-capture.ts` owns the hold-to-talk mechanics for every surface. What
 * is here is the board's answer to "what is this person talking ABOUT", which
 * has to be re-derived at the moment they press rather than at boot: the open
 * task panel, or the row their keyboard focus is on, plus the review item the
 * panel is aimed at so "pick the second one" answers THAT one.
 *
 * Exactly ONE capture may be mounted per page — Space is a singleton and two
 * captures would both claim it — so this is a mount, called once from boot,
 * not a render.
 *
 * `BoardVoiceDeps` is the whole list of what the mic may reach.
 */
import type {
  SpokenHeldSetups,
  SpokenSetup,
  SpokenTimingSummary,
} from '@claude-workspaces/core/spoken-reply';
import type { BootLocation } from '../boot-env.ts';
import { type VoiceAck, type VoiceCaptureOpts, createVoiceCapture } from '../voice-capture.ts';
import { type BoardState, fetchJson, send } from './board-actions.ts';
import { voiceBoardContext } from './board-presence-model.ts';
import { type SpokenReplyOpts, createSpokenReply } from './spoken-reply-client.ts';
import { writeSpokenDecision } from './spoken-review-decide.ts';

/** Everything the mic needs from `bootBoard`, and nothing else. */
export interface BoardVoiceDeps {
  /** The board's one projection: what the speaker is looking at. LIVE — read
   *  at press time, never captured at mount. */
  state: BoardState;
  /** Who is speaking, stamped on whatever the utterance files. */
  author: { id: string; name: string; kind: string; color?: string };
  /** The board the utterance is addressed to. */
  workspaceId: string;
  /** Read for `document.activeElement` — the focused row is "this ticket"
   *  as much as an open panel is. */
  document: Document;
  /** The address bar: a navigation the ack asks for. */
  location: Pick<BootLocation, 'origin' | 'pathname' | 'assign'>;
  /** `getElementById`, already narrowed — `bootBoard`'s own `el`. */
  el(id: string): HTMLElement;
  /** Repaint after an in-place task lookup opened the panel. */
  renderDetail(): void;
  /** "Make a plan", "have a meeting": the board's own two start buttons.
   *  The router asks for one as `?start=` on this board's address. */
  start?(kind: 'plan' | 'meeting'): void;
  /** Recognition, injectable for the same reason `voice-capture.ts` makes it
   *  injectable: no test environment has SpeechRecognition, and the board's
   *  half of the wiring — what a context names, and where an ack sends the
   *  reader — is only reachable through a completed utterance. Omitted by
   *  `bootBoard`, which takes the browser's own. */
  createRecognition?: VoiceCaptureOpts['createRecognition'];
  /**
   * Ask the server whether it can speak a reply (`GET …/voice/timings`) and,
   * if it names a setup, swap the plain mic for the spoken one
   * (`spoken-reply-client.ts`). `bootBoard` passes `{}`; a test passes the
   * seams it needs, and omitting it keeps the plain mic with no request.
   */
  spoken?: Partial<Pick<SpokenReplyOpts, 'openSocket' | 'startCapture' | 'playbackContext'>> & {
    host?: string;
    protocol?: string;
  };
}

/**
 * Mount the board's one voice capture. Call once, from boot.
 */
export function wireBoardVoice(deps: BoardVoiceDeps): void {
  const { state, author, workspaceId, document, location, el, renderDetail } = deps;

  // A task lookup on this same board opens the detail in place — the
  // session survives navigation (§3.8); everything else is a page move.
  const navigate = (u: string): void => {
    const url = new URL(u, location.origin);
    const taskParam = url.searchParams.get('task');
    const start = url.searchParams.get('start');
    if ((start === 'plan' || start === 'meeting') && url.pathname === location.pathname) {
      deps.start?.(start);
    } else if (taskParam && url.pathname === location.pathname) {
      state.detailTaskId = taskParam;
      renderDetail();
    } else {
      location.assign(u);
    }
  };
  // The open detail panel OR the highlighted row — see `voiceBoardContext`.
  // Both are "this ticket" to the person holding the mic.
  const getContext = () =>
    voiceBoardContext(
      state.detailTaskId,
      document.activeElement?.closest<HTMLElement>('.board-task-row')?.dataset.taskId,
      // The review item the panel is aimed at, so "pick the second one"
      // answers THAT one when the ticket has several.
      state.detailThreadId,
      // Or the ticket's own single review row, when the panel is open on it.
      state.reviewItems,
    );

  // Voice (§2.4/§3.8): hold Space or the mic button; the context object sent
  // with each utterance anchors it to wherever the speaker is NOW — the
  // board, or the open task detail. Every utterance gets an explicit ack.
  const capture = createVoiceCapture({
    button: el('board-mic'),
    indicator: el('board-voice'),
    ...(deps.createRecognition ? { createRecognition: deps.createRecognition } : {}),
    getContext,
    send: async (transcript, context) => {
      const res = await send(`/workspaces/${encodeURIComponent(workspaceId)}/voice`, 'POST', {
        transcript,
        context,
        author,
      });
      return res.ok && res.data ? (res.data as unknown as VoiceAck) : null;
    },
    onNavigate: navigate,
  });

  const spoken = deps.spoken;
  if (!spoken) return;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/voice`;
  void fetchJson<{
    setups?: SpokenSetup[];
    held?: SpokenHeldSetups;
    timings?: SpokenTimingSummary;
    off?: string;
  }>(`${base}/timings`).then((r) => {
    const setups = r?.setups ?? [];
    const held = r?.held ?? {};
    // This server's profile turned spoken replies off: the plain mic stays,
    // and says on hover and to a screen reader that it will not speak back.
    if (r?.off) {
      const mic = el('board-mic');
      mic.title = mic.title ? `${mic.title}. ${r.off}` : r.off;
      mic.setAttribute('aria-description', r.off);
    }
    if (setups.length === 0 && Object.keys(held).length === 0) return;
    // Space is a singleton: the plain capture goes before the spoken one mounts.
    capture.destroy();
    const protocol = spoken.protocol ?? window.location.protocol;
    const host = spoken.host ?? window.location.host;
    createSpokenReply({
      document,
      button: el('board-mic'),
      url: `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${base}/converse`,
      setups,
      held,
      timings: r?.timings ?? {},
      author,
      getContext,
      onNavigate: navigate,
      onDecide: (d) => writeSpokenDecision(d, { workspaceId, author, send }),
      ...(spoken.openSocket ? { openSocket: spoken.openSocket } : {}),
      ...(spoken.startCapture ? { startCapture: spoken.startCapture } : {}),
      ...(spoken.playbackContext ? { playbackContext: spoken.playbackContext } : {}),
    });
  });
}
