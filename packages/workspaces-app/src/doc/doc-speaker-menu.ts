/**
 * The menu behind a speaker tag in the notes: who said this, and what that
 * voice is called.
 *
 * Mounted whatever the doc type, and independent of the meeting strip: notes
 * outlive the meeting that produced them, and correcting an attribution a
 * week later is the ordinary case rather than the exotic one. What the strip
 * DOES give it, when there is one, is the roster it already loaded — which is
 * the difference between a menu that opens and one that waits.
 */
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountSpeakerReassign } from '../speaker-reassign-menu.ts';
import { loadDocVoices } from '../speaker-voices.ts';
import type { DocMeetingMount } from './doc-meeting-mount.ts';

export interface DocSpeakerMenuOptions {
  docId: string;
  editor: EditorHandle;
  scope: MountScope;
  /** Permission, not mode: a reader in view mode may still fix an
   *  attribution, and a reader without write access may not. */
  canWrite: () => boolean;
  /** Absent on a doc that mounted no meeting — then the roster is fetched
   *  on the tap, as it always was, and there is no rename channel to offer. */
  meeting?: DocMeetingMount;
}

export function mountDocSpeakerMenu(opts: DocSpeakerMenuOptions): void {
  const { docId, editor, scope, canWrite, meeting } = opts;
  const speakers = meeting?.speakers;
  const reassign = mountSpeakerReassign({
    editor: editor.editor,
    // The refresh behind the tap; the cached answer below is what the menu
    // actually paints, so the rows are there in the same turn as the finger.
    loadVoices: () =>
      speakers ? speakers.load().then((held) => held?.voices ?? []) : loadDocVoices(docId),
    ...(speakers ? { cachedVoices: () => speakers.peek()?.voices ?? null } : {}),
    canWrite,
    // The one entry about the VOICE rather than this mention: naming
    // Speaker A from the notes, after every other pill on the page has gone.
    ...(meeting?.renameSpeaker ? { renameSpeaker: meeting.renameSpeaker } : {}),
  });
  scope.onCleanup(() => reassign.destroy());
}
