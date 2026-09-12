/**
 * Read a workspace event stream the way a real attached session reads it.
 *
 * A nudge is ADDRESSED — `sendToAgent`, not a broadcast — so nothing short of
 * a held SSE stream can observe one, and three suites had grown their own
 * byte-identical copy of this reader with a comment pointing at the copy next
 * door. One copy, since the thing being read is the wire format rather than
 * anything about a particular wake.
 */
export type Frame = { event: string; data?: Record<string, unknown> };

export interface FrameListener {
  /** Every non-`message` frame that has arrived so far, oldest first. */
  frames: Frame[];
  /** Hang up, the way a session ending does. */
  stop: () => Promise<void>;
}

/** Attach to an already-open `text/event-stream` response. */
export function listenFrames(res: Response): FrameListener {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

/**
 * Wait until at least `n` frames of `event` have arrived, or give up.
 *
 * A fixed settle is a bet that this machine delivers an SSE frame inside that
 * window, and under a full-suite load it does not — which shows up as a wake
 * test failing on a branch that never touched the wake. Polling asserts the
 * same thing without the bet, and it cannot make a SILENCE test pass by
 * accident: a test expecting nothing still waits a fixed window and then
 * looks.
 *
 * The default is generous because a poll costs nothing when the answer is
 * already there — it returns on the first pass. The number is sized for this
 * machine under a full parallel agent load, where an HTTP round trip that
 * normally takes 3ms has been seen to take seconds.
 */
export async function waitForFrames(
  frames: readonly Frame[],
  event: string,
  n: number,
  timeoutMs = 15_000,
): Promise<Frame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
}
