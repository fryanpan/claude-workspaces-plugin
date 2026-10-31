/**
 * The voice facts every mic on the app shares: the context a spoken message
 * carries, whether this origin can open the microphone at all, what to tell
 * the person when recognition fails, and where a held Space belongs to the
 * page. The hold-to-talk capture that used to live here went with the
 * board's and the doc's own mics (Bryan, 2026-10-30); the lead chat, the
 * spoken-reply tap and the meeting recorder are what read these now.
 */

export interface VoiceContext {
  surface: 'board' | 'doc' | 'task';
  /** The thread the speaker has open — the review item they are "in", so a
   *  spoken answer lands on it rather than on whichever item is first. */
  threadId?: string;
  /** Same, for a review item that hangs on the ticket rather than a thread. */
  reviewItemId?: string;
  docId?: string;
  taskId?: string;
  visibleHeading?: string;
  /** The page's link to the most specific thing open on it
   *  (`lead-chat/lead-chat-link.ts`). */
  link?: string;
}

/**
 * The facts about the current origin that decide whether voice can run at
 * all. Injectable so the decision is testable without a browser.
 */
export interface OriginFacts {
  /** `window.isSecureContext` — the single thing the mic is gated on. */
  isSecureContext: boolean;
  protocol: string;
  hostname: string;
  /** `location.port` — '' when the scheme's default port is in use. */
  port: string;
  pathname: string;
  search: string;
}

/** The real page's origin. */
export function defaultOriginFacts(): OriginFacts {
  return {
    isSecureContext: window.isSecureContext,
    protocol: location.protocol,
    hostname: location.hostname,
    port: location.port,
    pathname: location.pathname,
    search: location.search,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The same page on loopback — which IS a secure context however it is served,
 * so it is the one origin that needs no TLS to make the mic work. Null when
 * the page is already there (nothing left to suggest).
 */
export function localhostUrlFor(loc: OriginFacts): string | null {
  if (LOOPBACK_HOSTS.has(loc.hostname)) return null;
  const port = loc.port === '' ? '' : `:${loc.port}`;
  return `http://localhost${port}${loc.pathname}${loc.search}`;
}

/**
 * Why voice cannot run on this origin, in one line someone can act on — or
 * null when the origin is fine.
 *
 * The microphone is gated on a SECURE CONTEXT. The server is normally reached
 * over plain http at a hostname (`http://<host>:8787/...`), which is not one;
 * loopback is exempt whatever its scheme. Verified in Chrome 151 against that
 * origin: the `SpeechRecognition` constructor is still THERE (so "unsupported
 * browser" is the wrong thing to say), `navigator.mediaDevices` is undefined,
 * and `start()` answers `not-allowed` immediately with no prompt.
 *
 * That last part is why this message must not suggest allowing the mic for
 * the site: on an insecure origin Chrome offers no such permission, so the
 * advice sends someone into site settings to look for a control that is not
 * there. Naming loopback is the one instruction that works today with no
 * certificate, no tunnel, and no configuration.
 */
export function insecureOriginMessage(loc: OriginFacts): string | null {
  if (loc.isSecureContext) return null;
  const url = localhostUrlFor(loc);
  const why = 'Voice needs https or localhost — on plain http the browser blocks the mic outright.';
  return url ? `${why} From the host machine, open ${url}` : why;
}

/**
 * What to tell the person, per recognition error code.
 *
 * The insecure-origin case no longer reaches here — `insecureOriginMessage`
 * catches it before the engine is started — so a `not-allowed` that gets this
 * far came from a SECURE origin, where it means the permission was genuinely
 * refused: denied for the site, or denied to the browser by the OS. Those are
 * the two places worth naming, and both are real controls that exist.
 */
export function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission refused — allow the mic for this site, and check the browser has mic access in the OS privacy settings.';
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Speech service unreachable — check the network.';
    case 'no-speech':
      return "Didn't catch anything.";
    case 'aborted':
      return 'Recording stopped.';
    default:
      return `Voice input failed (${code}).`;
  }
}

/**
 * The attribute a surface stamps on a container to say "a Space held here is
 * the page's, not mine" — see `spaceHoldTargetsPage`. One spelling, shared by
 * the predicate and by whoever marks the region.
 */
export const SPACE_HOLD_PAGE_ATTR = 'data-space-hold';

/**
 * Where a document-level Space hold may begin: on the page itself, and
 * nowhere else. A keydown's target is whatever has focus, and Space MEANS
 * something on almost any focused element — it activates a button, toggles a
 * checkbox, opens a select, "selects" a task row. `typingInPath` only knows
 * about text entry, so every one of those cases used to start a recording
 * (the accidental-trigger ticket). The honest positive predicate is narrow: the press is the
 * page's own only when it lands on body / the root / the document — which is
 * exactly the state of a reader who is not interacting with anything.
 *
 * Deliberately one-directional: everything this suppresses still has the mic
 * button, so a false "not the page" costs a click; the old false "not typing"
 * cost a corrupted sentence and a surprise recording.
 *
 * **The one widening**, and the reason it is safe: a surface that takes focus
 * onto a non-interactive CONTAINER — a dialog that must be readable and
 * dismissable from the keyboard — leaves the reader in exactly the state body
 * describes, with focus somewhere the browser assigns no meaning to Space.
 * The task detail panel is that case, and until it was covered, opening a task
 * from the board killed hold-to-talk outright: the click left focus on the
 * task row, so every press answered "not the page" and the mic never armed.
 * The marker is read off the FOCUSED element only, never an ancestor, so a
 * button or a select inside such a container keeps Space for itself.
 */
export function spaceHoldTargetsPage(path: readonly (EventTarget | undefined)[]): boolean {
  const inner = path[0];
  if (!inner) return false;
  if (inner instanceof Document) return true;
  if (!(inner instanceof Element)) return false;
  const doc = inner.ownerDocument;
  if (inner === doc.body || inner === doc.documentElement) return true;
  return inner.getAttribute(SPACE_HOLD_PAGE_ATTR) === 'page';
}
