import { type Anchor, MAX_VOICE_RAW, type VoiceNote } from '@claude-workspaces/core';
import type { PostedComment, VoicePoster } from './voice-post.ts';

/**
 * A recording's notes kept in step with threads (`voice-session.ts`): the
 * first write for a note creates its thread, a later one re-anchors it when
 * its element changed and edits it when its words did. One write at a time
 * per note, each reading the note as it is then, so an edit never overtakes
 * the create before it.
 */

/** The part of a note the writes read; `VoiceComment` is one. */
export interface WrittenNote {
  key: string;
  text: string;
  raw: string;
  clip: string;
  target: number | null;
  posted?: PostedComment;
  refused?: boolean;
}

export interface NoteWritesDeps<N extends WrittenNote> {
  poster: VoicePoster;
  anchorFor: (target: number | null) => Anchor;
  /** The create answered. */
  posted: (n: N, posted: PostedComment) => void;
  /** A write was refused, or threw. */
  refuse: (n: N) => void;
}

export class NoteWrites<N extends WrittenNote> {
  private chains = new Map<string, Promise<void>>();
  private sent = new Map<
    string,
    { text: string; raw: string; clip: string; target: number | null }
  >();

  constructor(private readonly deps: NoteWritesDeps<N>) {}

  sync(n: N): void {
    const prev = this.chains.get(n.key) ?? Promise.resolve();
    this.chains.set(
      n.key,
      prev.then(() => this.push(n)).catch(() => this.deps.refuse(n)),
    );
  }

  private async push(n: N): Promise<void> {
    if (n.refused || !n.text.trim()) return;
    const { poster, anchorFor } = this.deps;
    const voice: VoiceNote = { clip: n.clip, raw: n.raw.slice(-MAX_VOICE_RAW) };
    const was = this.sent.get(n.key);
    const now = { text: n.text, raw: voice.raw, clip: n.clip, target: n.target };
    if (!n.posted) {
      const posted = await poster.create(anchorFor(n.target), n.text, voice);
      if (!posted) return this.deps.refuse(n);
      n.posted = posted;
      this.sent.set(n.key, now);
      this.deps.posted(n, posted);
      return;
    }
    if (!was) return;
    if (was.target !== now.target) {
      if (!(await poster.reanchor(n.posted.threadId, anchorFor(n.target)))) {
        return this.deps.refuse(n);
      }
      was.target = now.target;
    }
    if (was.text !== now.text || was.raw !== now.raw || was.clip !== now.clip) {
      if (!(await poster.edit(n.posted, n.text, voice))) return this.deps.refuse(n);
      Object.assign(was, { text: now.text, raw: now.raw, clip: now.clip });
    }
  }
}
