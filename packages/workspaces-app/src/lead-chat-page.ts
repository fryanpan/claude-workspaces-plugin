/**
 * The lead chat on a page that holds a frame it cannot draw into: a mock, an
 * HTML attachment or a dev server, shown sandboxed inside the host page
 * (`mockup-frame.ts` on the server). The host loads this with the board and
 * doc it is showing, and never for a share visitor; the chat draws its button
 * only for the board's owner.
 *
 * Its own entry, like `coach-page.ts`: the host page carries no app bundle.
 */
import { ensureUserIdentity } from './identity-prompt.ts';
import { mountLeadChat } from './lead-chat/lead-chat-mount.ts';

const tag = document.querySelector<HTMLScriptElement>('script[data-lead-chat-page]');
const workspaceId = tag?.dataset.workspaceId;
const docId = tag?.dataset.docId;
if (workspaceId) {
  const storage = {
    get: (k: string) => localStorage.getItem(k),
    set: (k: string, v: string) => localStorage.setItem(k, v),
  };
  // The host page is not where anybody is asked their name: the signed-in
  // identity, or the one this browser already chose.
  void ensureUserIdentity(null, storage, { suppressNamePrompt: true }).then((user) =>
    mountLeadChat({
      workspaceId,
      author: { id: user.id, name: user.name, kind: user.kind },
      getContext: () => (docId ? { surface: 'doc', docId } : undefined),
    }),
  );
}
