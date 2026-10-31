/**
 * The menu behind a speaker tag in the notes: who said this, and what that
 * voice is called.
 *
 * Mounted whatever the doc type: notes outlive the meeting that produced
 * them, and correcting an attribution a week later is the ordinary case
 * rather than the exotic one. The roster is fetched on the tap.
 */
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountSpeakerReassign } from '../speaker-reassign-menu.ts';
import { loadDocVoices } from '../speaker-voices.ts';

export interface DocSpeakerMenuOptions {
  docId: string;
  editor: EditorHandle;
  scope: MountScope;
  /** Permission, not mode: a reader in view mode may still fix an
   *  attribution, and a reader without write access may not. */
  canWrite: () => boolean;
}

export function mountDocSpeakerMenu(opts: DocSpeakerMenuOptions): void {
  const { docId, editor, scope, canWrite } = opts;
  const reassign = mountSpeakerReassign({
    editor: editor.editor,
    loadVoices: () => loadDocVoices(docId),
    canWrite,
  });
  scope.onCleanup(() => reassign.destroy());
}
