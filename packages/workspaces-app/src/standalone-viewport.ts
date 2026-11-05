/**
 * Make iOS re-measure a home-screen app's viewport after the keyboard goes.
 *
 * Reported on iOS 26: in standalone mode the viewport shrinks when the keyboard
 * opens and does not grow back when it closes, so `position: fixed` elements
 * stay about a keyboard's height up the screen until the app is relaunched.
 * Home's tab bar was seen there on Bryan's iPhone, 5 Nov. Headless Chromium has
 * no such bug, so this has never been seen to work; only that phone can show it.
 *
 * The remedy is the published one: take a full-height element out of layout
 * and back in, inside one task, so nothing paints. Home has no app wrapper, so
 * that element is the body, and the scroll position comes back after it.
 *
 * It runs on every text field's blur rather than behind a height check,
 * because the screenshot suggests the page's own measurements looked normal:
 * the widget, reading them, found no bar where the bar was drawn.
 */
const FIELD = 'textarea, input, [contenteditable]';

/** How long the keyboard takes to go. From the published remedy. */
export const HEAL_DELAY_MS = 140;

const isField = (t: EventTarget | undefined): boolean =>
  (t as Element | undefined)?.matches?.(FIELD) === true;

/** Whether a field still has focus, inside any shadow root: the keyboard stays. */
function fieldFocused(doc: Document): boolean {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return isField(active ?? undefined);
}

function heal(win: Window): void {
  const { body } = win.document;
  const y = win.scrollY;
  const display = body.style.display;
  body.style.display = 'none';
  void body.offsetHeight;
  body.style.display = display;
  win.scrollTo(0, y);
}

/** Wire the re-measure, in a home-screen app only. */
export function wireStandaloneViewportHeal(win: Window = window): void {
  const iosStandalone = (win.navigator as { standalone?: boolean }).standalone === true;
  if (!iosStandalone && !win.matchMedia('(display-mode: standalone)').matches) return;
  win.document.addEventListener('focusout', (ev) => {
    // The first of the path, because a field in a shadow root retargets.
    if (!isField(ev.composedPath()[0])) return;
    win.setTimeout(() => {
      if (!fieldFocused(win.document)) heal(win);
    }, HEAL_DELAY_MS);
  });
}
