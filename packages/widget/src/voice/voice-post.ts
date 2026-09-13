import type { Anchor, VoiceNote } from '@claude-workspaces/core';
import { authedPost, httpBase } from '../widget-auth.ts';
import type { FeedbackWidgetEl } from '../widget.ts';

/**
 * The thread routes a spoken comment is written through — the same ones a
 * typed comment uses, so a voice comment is a comment like any other:
 * attributed to the widget's identity, re-anchored by the same sweep, undone
 * by resolving it.
 *
 * Through `authedPost`, so a workspace that wants a signature asks for one
 * exactly as it does for the typed composer.
 */

export interface PostedComment {
  threadId: string;
  commentId: string;
  /** Who the server says wrote it — a signed-in name wins over the widget's own. */
  author?: string;
}

export interface VoicePoster {
  create(anchor: Anchor, text: string, voice: VoiceNote): Promise<PostedComment | null>;
  edit(at: PostedComment, text: string, voice: VoiceNote): Promise<boolean>;
  reanchor(threadId: string, anchor: Anchor): Promise<boolean>;
  setResolved(threadId: string, resolved: boolean): Promise<boolean>;
}

const enc = encodeURIComponent;

export function widgetPoster(el: FeedbackWidgetEl): VoicePoster {
  const base = (): string =>
    `${httpBase(el)}/workspaces/${enc(el.opts.workspaceId)}/docs/${enc(el.opts.docId)}/threads`;
  const post = (path: string, body: () => unknown): Promise<Response> =>
    authedPost(el, `${base()}${path}`, () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    }));
  return {
    async create(anchor, text, voice) {
      const res = await post('', () => ({ author: el.user, text, anchor, voice }));
      if (!res.ok) return null;
      const { thread } = (await res.json()) as {
        thread?: { id?: string; comments?: Array<{ id?: string; author?: { name?: unknown } }> };
      };
      const first = thread?.comments?.[0];
      const commentId = first?.id;
      if (!thread?.id || !commentId) return null;
      const author = first?.author?.name;
      return {
        threadId: thread.id,
        commentId,
        ...(typeof author === 'string' && author ? { author } : {}),
      };
    },
    async edit(at, text, voice) {
      const res = await post(`/${enc(at.threadId)}/edit-comment`, () => ({
        author: el.user,
        commentId: at.commentId,
        text,
        voice,
      }));
      // "unchanged" is a 409 that means the words already say this.
      return res.ok || res.status === 409;
    },
    async reanchor(threadId, anchor) {
      return (await post(`/${enc(threadId)}/reanchor`, () => ({ anchor }))).ok;
    },
    async setResolved(threadId, resolved) {
      const res = await post(`/${enc(threadId)}/${resolved ? 'resolve' : 'reopen'}`, () => ({
        author: el.user,
      }));
      return res.ok;
    },
  };
}
