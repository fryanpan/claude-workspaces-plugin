/**
 * Whether this tab is the one its person is attending to: the page is
 * visible and its window holds focus. Every page announces it in the
 * board's presence room (`ATTENDING_FIELD`), so the server can tell the
 * person's foreground tab from tabs left in the background or open on
 * another device, and move only that one (`person-presence.ts`).
 */

/** The slice of `window` and `document` this reads. */
export interface AttentionHost {
  win: Pick<Window, 'addEventListener'>;
  doc: Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener'>;
}

export interface Attention {
  attending(): boolean;
}

export function watchAttention(host: AttentionHost, onChange: () => void): Attention {
  const read = (): boolean => host.doc.visibilityState === 'visible' && host.doc.hasFocus();
  let last = read();
  const check = (): void => {
    const now = read();
    if (now === last) return;
    last = now;
    onChange();
  };
  for (const name of ['focus', 'blur', 'pageshow', 'pagehide'] as const) {
    host.win.addEventListener(name, check);
  }
  host.doc.addEventListener('visibilitychange', check);
  return { attending: () => last };
}
