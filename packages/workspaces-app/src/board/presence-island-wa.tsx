/**
 * The board's presence strip drawn from Web Awesome components (D1 step 10).
 *
 * Only the face changes. Each circle is a `<wa-avatar>` — initials, a circle
 * for a person and a rounded square for an agent — inside a bare button, and
 * the button is the strip's own (`presence-island.tsx`): the same keyed rows,
 * long-press to follow, tap to jump, four-slot clamp, titles and labels. A
 * native button rather than `<wa-button>` because the press gesture, focus
 * and the 36px hit area are the behaviour this must keep, and they live on
 * the button.
 *
 * The strip's toasts — "Following Alice — long-press again to stop" and the
 * "+N" names — come from `<wa-toast>` here, styled in board.css to look and
 * time out like the board's own toast: one at a time, a new one replacing the
 * last, gone after 3.5s, no close button and no animation.
 *
 * Loaded by `presence-core-switch.ts` with `import()`, so this module, the
 * avatar, the toast and Lit are a chunk of their own that a board on the current code
 * never fetches. Linking the theme file happens here for the same reason.
 */
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import type WaToast from '@awesome.me/webawesome/dist/components/toast/toast.js';
import type { JSX } from 'preact';
import { BUILD_ID } from '../stale-client.ts';
import { type PresenceChip, initialsOf, presenceHue } from './board-presence-model.ts';
import {
  type PresenceFace,
  type PresenceHandlers,
  mountPresenceIsland,
} from './presence-island.tsx';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'wa-avatar': JSX.HTMLAttributes<HTMLElement> & {
        initials?: string;
        shape?: 'circle' | 'square' | 'rounded';
        label?: string;
      };
    }
  }
}

/** The avatar is decoration: the button around it carries the name in its
 *  `aria-label` and `title`, so the avatar's own `role="img"` label would be
 *  read a second time. */
const avatar = (initials: string, shape: 'circle' | 'rounded', style?: JSX.CSSProperties) => (
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: wa-avatar takes no focus; the button around it does.
  <wa-avatar initials={initials} shape={shape} aria-hidden="true" style={style} />
);

export const WA_FACE: PresenceFace = {
  base: 'board-presence-wa',
  circle: (chip: PresenceChip) =>
    avatar(initialsOf(chip.label), chip.kind === 'agent' ? 'rounded' : 'circle', {
      backgroundColor: `hsl(${presenceHue(chip.label)}, 45%, 45%)`,
    }),
  more: (hidden: PresenceChip[]) => avatar(`+${hidden.length}`, 'circle'),
};

/** Where the theme file is served. The build id busts a cached copy when the
 *  file changes, the way a hashed shell asset name does. */
export const WA_THEME_HREF = `/app/wa-theme.css${BUILD_ID ? `?v=${BUILD_ID}` : ''}`;

/** Link the Workspaces theme file once per page. */
export function linkWaTheme(doc: Document = document): void {
  if (doc.querySelector('link[data-wa-theme]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = WA_THEME_HREF;
  link.setAttribute('data-wa-theme', '');
  doc.head.appendChild(link);
}

/** The compact strip, Web Awesome face, into a wrapper appended to `host`. */
export function mountWaPresenceIsland(host: HTMLElement, handlers: PresenceHandlers): () => void {
  linkWaTheme(host.ownerDocument);
  return mountPresenceIsland(host, handlers, { compact: true, face: WA_FACE });
}

/** How long a strip toast stands: the board toast's own default. */
export const WA_TOAST_MS = 3500;

/** The one `<wa-toast>` the strip's toasts go through, made on first use. */
function toastStack(doc: Document): WaToast {
  const found = doc.querySelector<WaToast>('wa-toast.board-wa-toast');
  if (found) return found;
  const stack = doc.createElement('wa-toast');
  stack.className = 'board-wa-toast';
  stack.setAttribute('placement', 'bottom-center');
  doc.body.appendChild(stack);
  return stack;
}

/** Show `message` as the strip's toast, replacing one still showing. */
export function showWaToast(message: string, doc: Document = document): void {
  const stack = toastStack(doc);
  for (const item of stack.querySelectorAll('wa-toast-item')) item.remove();
  stack
    .create(message, { duration: WA_TOAST_MS, variant: 'neutral' })
    .catch((err) => console.error('[presence] the Web Awesome toast did not show:', err));
}

/** Take the toast stack off the page, when the strip goes back to today's. */
export function removeWaToast(doc: Document = document): void {
  doc.querySelector('wa-toast.board-wa-toast')?.remove();
}
