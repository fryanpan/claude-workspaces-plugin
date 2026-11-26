/**
 * A stand-in for the board's EventSource, shared by the lead chat client's
 * test files: it records listeners and fires a named frame at them.
 */
export class FakeStream {
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  closed = false;
  /** CONNECTING, as a stream opened for this client is. */
  readyState = 0;
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, data?: unknown) {
    const ev = new MessageEvent(type, data === undefined ? {} : { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/** One macrotask, so a resolved read's continuation has run. */
export const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));
