import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * A REMOTE EDIT DOES NOT SCROLL THE PAGE.
 *
 * y-prosemirror applies an edit from another client (an agent's
 * `block_edits`, `find_and_replace`, another reader's typing) as one step
 * replacing the whole document, puts the reader's caret back in the same
 * words, and, when the caret was on screen, asks the view to scroll it into
 * view. ProseMirror does that scroll inside `updateState`, before anything
 * else sees the change. When the edit pushed the caret off screen, the page
 * scrolled just far enough to show it at the pane's edge: at 430x932 an
 * insert above put the caret 300px further down the screen, which on an iPad
 * with the keyboard up is behind the keyboard. The reading hold
 * (`reading-hold.ts`) would have kept the caret on its pixel, but it sees the
 * pane already moved, takes that as the reader scrolling, and starts over
 * from the new position.
 *
 * So a scroll a remote edit asked for is dropped, and the reading hold alone
 * decides where the page sits. An undo is not remote: the reader asked for
 * it, and its scroll still runs.
 */

/** Whether a transaction is a remote change the sync plugin applied. */
export function isRemoteSync(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean }
    | undefined;
  return meta?.isChangeOrigin === true && meta.isUndoRedoOperation !== true;
}

/** True while the latest scroll request came from a remote edit. */
const remoteScrollKey = new PluginKey<boolean>('remote-edit-scroll');

export const RemoteEditsKeepScroll = Extension.create({
  name: 'remoteEditsKeepScroll',
  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: remoteScrollKey,
        state: {
          init: () => false,
          apply: (tr, prev) => (isRemoteSync(tr) ? true : tr.scrolledIntoView ? false : prev),
        },
        props: {
          handleScrollToSelection: (view) => remoteScrollKey.getState(view.state) === true,
        },
      }),
    ];
  },
});
