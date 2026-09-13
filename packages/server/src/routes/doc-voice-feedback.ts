import { existsSync } from 'node:fs';
import { voiceLogPath, voiceSegmentPath } from '../voice-feedback-store.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * What a voice feedback session kept beside a page: its log and its
 * recordings.
 *
 *   GET /workspaces/<ws>/docs/<docId>/voice-feedback.md
 *   GET /workspaces/<ws>/docs/<docId>/voice-feedback/seg-<N>.wav
 *
 * A spoken comment's ▶ plays a stretch of one recording (`VoiceNote.clip`),
 * and "Raw words" leads to the log. Both are the speaker's own voice and
 * words, so the gate is **trusted-local**, like the socket that made them: a
 * share visitor reads a voice comment's text and not its audio, and is refused
 * here as well as at admission so a later widening of an allowed prefix
 * cannot open it silently.
 *
 * The file name is matched against `seg-<digits>.wav` before it is joined to
 * a path (`voiceSegmentPath`), so nothing a request says can climb out of the
 * doc's own recording folder.
 *
 * Byte ranges are answered, because Safari will not play an `<audio>` whose
 * server ignores `Range`, and a clip's `#t=` start is a seek.
 */
export async function handleDocVoiceFeedbackRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, visitor, rest, docId } = rq;
  const { j } = ctx;
  let path: string | null;
  let type: string;
  if (rest === 'voice-feedback.md') {
    path = voiceLogPath(ctx.dataDir, docId);
    type = 'text/markdown; charset=utf-8';
  } else if (rest.startsWith('voice-feedback/')) {
    path = voiceSegmentPath(ctx.dataDir, docId, rest.slice('voice-feedback/'.length));
    type = 'audio/wav';
    if (!path) return j(404, { error: 'not-found' });
  } else {
    return undefined;
  }
  if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (!existsSync(path)) return j(404, { error: 'not-found' });
  const file = Bun.file(path);
  const size = file.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (!range || (range[1] === '' && range[2] === '')) {
    return new Response(file, { headers });
  }
  let start: number;
  let end: number;
  if (range[1] === '') {
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  // Read, not handed over as a file slice: the server re-wraps every response
  // as `new Response(res.body, …)`, and Bun streams the WHOLE file behind a
  // sliced BunFile's body — a 206 claiming 100 bytes then sent all of them.
  return new Response(await file.slice(start, end + 1).arrayBuffer(), {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
  });
}
