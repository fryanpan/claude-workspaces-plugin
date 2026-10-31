/**
 * `GET` and `POST /workspaces/<id>/lead-chat` — the board's chat with its lead
 * (`lead-chat/lead-chat.ts`) — and `POST /workspaces/<id>/lead-chat/meeting`,
 * the meeting it runs (`lead-chat/meeting.ts`).
 *
 * A `GET` with `beforeTs` and `beforeId` is a page back through the history:
 * the `limit` messages before that one (`LeadChatHistoryPage`).
 *
 * The read is a member's: everything in a workspace is available to everyone
 * in it. The write is the owner's alone, as talking to an agent by name on
 * the converse socket is, because the lead acts on what it is told with the
 * owner's reach. Neither path is in the share member table
 * (`middleware/host-guard.ts`), and both refuse a visitor here besides.
 */
import {
  LEAD_CHAT_MAX_CHARS,
  LEAD_CHAT_PAGE,
  LEAD_CHAT_PAGE_MAX,
  type LeadChatCursor,
  addressesLead,
} from '@claude-workspaces/core/lead-chat';
import { SPOKEN_OUTPUT_RATE } from '@claude-workspaces/core/spoken-reply';
import { isValidAgentId } from '../agent-watches.ts';
import { leadHearsLine } from '../lead-chat/meeting.ts';
import { hasOwnerProof } from '../share/owner-proof.ts';
import { parseVoiceContext } from '../voice.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export async function handleWorkspaceLeadChat(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, scope, visitor, authorFor, requireOwner } = rq;
  if (scope && /^\/workspaces\/[^/]+\/lead-chat\/meeting\/say$/.test(pathname)) {
    if (req.method !== 'POST') return undefined;
    if (visitor) return ctx.j(403, { error: 'not a member route' });
    return leadSays(ctx, req, scope.workspaceId);
  }
  if (scope && /^\/workspaces\/[^/]+\/lead-chat\/meeting$/.test(pathname)) {
    if (req.method !== 'POST') return undefined;
    if (visitor) return ctx.j(403, { error: 'not a member route' });
    return meetingAction(ctx, rq, scope.workspaceId);
  }
  if (!scope || !/^\/workspaces\/[^/]+\/lead-chat$/.test(pathname)) return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  if (visitor) return ctx.j(403, { error: 'not a member route' });
  const { workspaceId } = scope;
  const denied = requireOwner(workspaceId);
  // A member who may not write is still shown the chat, and told so, which
  // is what lets a page draw no composer rather than one that refuses.
  if (req.method === 'GET') {
    const q = rq.url.searchParams;
    if (q.has('beforeTs') || q.has('beforeId')) {
      const cursor = historyCursor(q.get('beforeTs'), q.get('beforeId'));
      const limit = pageLimit(q.get('limit'));
      if (!cursor || limit === null) {
        return ctx.j(400, {
          error: 'bad history page',
          hint: `beforeTs (a whole number), beforeId (a message id) and limit (1-${LEAD_CHAT_PAGE_MAX}, optional).`,
        });
      }
      const page = await ctx.leadChat.page(workspaceId, cursor, limit);
      return page ? ctx.j(200, page) : ctx.j(500, { error: 'history-unreadable' });
    }
    return ctx.j(200, {
      ...ctx.leadChat.snapshot(workspaceId),
      meeting: ctx.leadChatMeetings.current(workspaceId),
      canTalk: !denied,
    });
  }
  if (denied) return denied;
  const body = await ctx.safeJson(req);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return ctx.j(400, { error: 'text required' });
  if (text.length > LEAD_CHAT_MAX_CHARS) {
    return ctx.j(400, { error: `text over ${LEAD_CHAT_MAX_CHARS} chars` });
  }
  const author = authorFor(body?.author);
  if (!author) return ctx.j(400, { error: 'author required' });
  const context = parseVoiceContext(body?.context, workspaceId);
  // Dictated on the page rather than typed; the lead reads it the same way.
  const via = body?.via === 'voice' ? 'voice' : 'chat';
  const res = ctx.leadChat.post(
    workspaceId,
    { id: author.id, name: author.name },
    text,
    context,
    via,
  );
  if (!res.ok) return ctx.j(500, { error: res.error });
  return ctx.j(201, { message: res.message });
}

/** A message id as `parseLeadChatMessage` accepts one. */
const MESSAGE_ID = /^[A-Za-z0-9_~.-]{1,200}$/;

function historyCursor(ts: string | null, messageId: string | null): LeadChatCursor | null {
  if (ts === null || messageId === null || !/^\d{1,16}$/.test(ts)) return null;
  if (!MESSAGE_ID.test(messageId)) return null;
  return { ts: Number(ts), id: messageId };
}

function pageLimit(v: string | null): number | null {
  if (v === null) return LEAD_CHAT_PAGE;
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= LEAD_CHAT_PAGE_MAX ? n : null;
}

/** Ids the server minted: docs, meetings, the recorder's own token. */
const ID = /^[A-Za-z0-9_~.-]{1,160}$/;
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const short = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length > 0 && t.length <= max ? t : null;
};
const NOTES = ['existing', 'new', 'none'] as const;
const SOURCES = ['mic', 'mix', 'bot'] as const;
const pick = <T extends string>(v: unknown, of: readonly T[]): T | null =>
  of.includes(v as T) ? (v as T) : null;
/** The longest line a page may send: one turn of speech. */
const LINE_MAX = 4000;

/**
 * One verb on the board's meeting, named by `action`:
 *
 *   - `start` — `{docId, docTitle, notes, source, speakers, recorder}`.
 *   - `recording` — `{id, meetingId, recorder, docId?, docTitle?}`: the
 *     recording opened, resumed after a page move, or moved to a notes doc.
 *   - `line` — `{id, turn, who, text}`: one final line. A line that opens
 *     with "Lead," also goes to the lead, as a message said to it.
 *   - `join` — `{id}`: a person opened a page while it runs.
 *   - `voice` — `{id, turn}`: the audio of a line the lead said
 *     (`leadLineVoice`), for the page holding the microphone to play.
 *   - `end` — `{id}`.
 *
 * Every verb but `join` is the owner's, as the chat's own write is: a meeting
 * spends the owner's transcription and talks to the owner's lead. `join`
 * only adds the caller's face, so any member may.
 */
async function meetingAction(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
  workspaceId: string,
): Promise<Response> {
  const body = await ctx.safeJson(rq.req);
  const action = body?.action;
  const author = rq.authorFor(body?.author);
  if (!author) return ctx.j(400, { error: 'author required' });
  const person = { id: author.id, name: author.name };
  const answer = (r: { ok: true } | { ok: false; error: string }, ok: Record<string, unknown>) =>
    r.ok
      ? ctx.j(200, ok)
      : ctx.j(r.error === 'no-meeting' ? 409 : r.error === 'meeting-running' ? 409 : 500, {
          error: r.error,
        });
  const meetings = ctx.leadChatMeetings;
  const meetingId = id(body?.id);
  if (action === 'join') {
    if (!meetingId) return ctx.j(400, { error: 'id required' });
    const r = meetings.join(workspaceId, meetingId, person);
    return answer(r, r.ok ? { meeting: r.meeting } : {});
  }
  const denied = rq.requireOwner(workspaceId);
  if (denied) return denied;
  const onBoard = (docId: string): boolean =>
    ctx.docStore.get(docId) !== undefined &&
    (ctx.taskStore.getWorkspace(workspaceId)?.docIds.includes(docId) ?? false);
  if (action === 'start') {
    const docId = id(body?.docId);
    const docTitle = short(body?.docTitle, 200);
    const notes = pick(body?.notes, NOTES);
    const source = pick(body?.source, SOURCES);
    const speakers = pick(body?.speakers, ['solo', 'conversation'] as const);
    const recorder = id(body?.recorder);
    if (!docId || !docTitle || !notes || !source || !speakers || !recorder) {
      return ctx.j(400, {
        error: 'bad start',
        hint: 'docId, docTitle, notes (existing|new|none), source (mic|mix|bot), speakers (solo|conversation) and recorder are required.',
      });
    }
    if (!onBoard(docId)) return ctx.j(404, { error: 'doc-not-on-board' });
    const r = meetings.start(workspaceId, {
      by: person,
      docId,
      docTitle,
      notes,
      source,
      speakers,
      recorder,
    });
    if (r.ok) ctx.leadMeetingFeed.started(workspaceId, r.meeting);
    return r.ok ? ctx.j(201, { meeting: r.meeting }) : answer(r, {});
  }
  if (!meetingId) return ctx.j(400, { error: 'id required' });
  if (action === 'recording') {
    const recording = id(body?.meetingId);
    const recorder = id(body?.recorder);
    if (!recording || !recorder) return ctx.j(400, { error: 'meetingId and recorder required' });
    const docId = body?.docId === undefined ? undefined : id(body.docId);
    if (docId === null) return ctx.j(400, { error: 'bad docId' });
    if (docId !== undefined && !onBoard(docId)) return ctx.j(404, { error: 'doc-not-on-board' });
    const docTitle = body?.docTitle === undefined ? undefined : short(body.docTitle, 200);
    if (docTitle === null) return ctx.j(400, { error: 'bad docTitle' });
    const r = meetings.recording(workspaceId, meetingId, {
      meetingId: recording,
      recorder,
      ...(docId ? { docId } : {}),
      ...(docTitle ? { docTitle } : {}),
    });
    return answer(r, r.ok ? { meeting: r.meeting } : {});
  }
  if (action === 'line') {
    const turn = body?.turn;
    const who = short(body?.who, 200);
    const text = short(body?.text, LINE_MAX);
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0 || !who || !text) {
      return ctx.j(400, { error: 'turn, who and text required' });
    }
    const source = meetings.current(workspaceId)?.source;
    const r = meetings.line(workspaceId, meetingId, { turn, who, text });
    if (!r.ok) return answer(r, {});
    // The one line of the meeting the lead acts on, sent once per turn: a
    // revision of a turn the meeting already holds is not a second ask.
    let toLead: string | undefined;
    let refused: 'sign-in' | undefined;
    if (r.fresh && addressesLead(text) && source) {
      const proven = hasOwnerProof(rq.req, rq.provenIdentityFor, rq.requestOriginFor);
      if (leadHearsLine(source, proven)) {
        const sent = ctx.leadChat.post(workspaceId, person, text, undefined, 'voice');
        if (sent.ok) toLead = sent.message.id;
      } else if (leadHearsLine(source, true)) {
        // Only the sign-in is missing, so the page can say so.
        refused = 'sign-in';
      }
    }
    // Everything else the room says, the lead hears as the meeting goes.
    const m = meetings.current(workspaceId);
    if (r.fresh && !toLead && m) ctx.leadMeetingFeed.heard(workspaceId, m, r.line);
    return ctx.j(200, {
      line: r.line,
      ...(toLead ? { message: toLead } : {}),
      ...(refused ? { lead: refused } : {}),
    });
  }
  if (action === 'voice') return leadLineVoice(ctx, rq.req, workspaceId, meetingId, body?.turn);
  if (action === 'end') {
    const r = meetings.end(workspaceId, meetingId);
    if (r.ok) ctx.leadMeetingFeed.ended(workspaceId);
    return answer(r, {});
  }
  return ctx.j(400, { error: 'unknown action' });
}

/** The longest line the lead may say into a meeting, in characters. */
export const LEAD_SAY_MAX = 1000;

/**
 * `POST /workspaces/<id>/lead-chat/meeting/say` — `{agentId, text}`: the
 * board's lead speaks into the meeting its chat is running
 * (`say_in_meeting`). The line shows on every page of the board and the page
 * holding the microphone plays it. Only the board's lead, proved the way its
 * own feed is (on this machine, with its token), may say anything; a
 * meeting must be running.
 */
async function leadSays(
  ctx: WorkspaceRoutesContext,
  req: Request,
  workspaceId: string,
): Promise<Response> {
  const body = await ctx.safeJson(req);
  const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
  if (!isValidAgentId(agentId)) return ctx.j(400, { error: 'agentId required' });
  const allowed = ctx.authorizeAgent(req, agentId);
  if (!allowed.ok) return ctx.j(allowed.status, allowed.body);
  if (ctx.taskStore.getWorkspace(workspaceId)?.leadAgentId !== agentId) {
    return ctx.j(403, { error: 'not-lead', hint: 'Only the board’s lead speaks in its meeting.' });
  }
  const text = typeof body?.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : '';
  if (!text) return ctx.j(400, { error: 'text required' });
  if (text.length > LEAD_SAY_MAX) return ctx.j(400, { error: `text over ${LEAD_SAY_MAX} chars` });
  const who = ctx.leadChat.leadAuthor(workspaceId, agentId).name;
  const r = ctx.leadChatMeetings.said(workspaceId, who, text);
  if (!r.ok) {
    return r.error === 'no-meeting'
      ? ctx.j(409, { error: 'no-meeting', hint: 'No meeting is running on this board.' })
      : ctx.j(500, { error: r.error });
  }
  return ctx.j(200, {
    ok: true,
    meetingId: r.meeting.id,
    turn: r.line.turn,
    played: ctx.leadMeetingVoice !== null && r.meeting.source !== 'bot',
  });
}

/**
 * The audio of line `turn`, which the lead said: PCM16 mono at
 * `SPOKEN_OUTPUT_RATE`, streamed as the voice makes it. Only a lead line
 * is voiced, so a page cannot spend the voice on arbitrary words.
 */
function leadLineVoice(
  ctx: WorkspaceRoutesContext,
  req: Request,
  workspaceId: string,
  meetingId: string,
  turn: unknown,
): Response {
  const m = ctx.leadChatMeetings.current(workspaceId);
  if (!m || m.id !== meetingId) return ctx.j(409, { error: 'no-meeting' });
  const line = m.lines.find((l) => l.turn === turn && l.lead);
  if (!line) return ctx.j(404, { error: 'no-lead-line' });
  const voice = ctx.leadMeetingVoice;
  if (!voice) return ctx.j(503, { error: 'no-voice' });
  const stop = new AbortController();
  req.signal.addEventListener('abort', () => stop.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        await voice.speak(line.text, (pcm) => c.enqueue(pcm), stop.signal);
      } catch (err) {
        console.error(`[lead-chat] the lead's line was not voiced: ${String(err)}`);
      }
      try {
        c.close();
      } catch {
        // Closed by the page going away.
      }
    },
    cancel() {
      stop.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'audio/L16',
      'x-sample-rate': String(SPOKEN_OUTPUT_RATE),
      'cache-control': 'no-store',
    },
  });
}
