/**
 * The fakes `createChannelMessages` is driven with.
 *
 * It takes its notification sink, its HTTP client and this session's identity
 * as arguments, so a test hands it these and reads the frame it produced —
 * no socket, no server, no grep over a bundle.
 *
 * Shared by `channel-messages.test.ts` and `channel-messages-dispatch.test.ts`
 * rather than copied into both: one clock and one identity means a frame's
 * `sent_at` reads the same in either file.
 */
import { expect } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';

/** A frozen clock, so `sent_at` is an assertion rather than a race. */
export const FIXED_MS: number = Date.UTC(2026, 8, 3, 12, 0, 0);
export const FIXED_ISO: string = new Date(FIXED_MS).toISOString();

export const SELF = 'agent-workspaces';

export type Sent = { method: string; path: string; body: unknown };

export interface ChannelHarness {
  frames: ChannelNotification['params'][];
  sent: Sent[];
  messages: ReturnType<typeof createChannelMessages>;
}

export function harness(opts: { authorId?: string } = {}): ChannelHarness {
  const frames: ChannelNotification['params'][] = [];
  const sent: Sent[] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      expect(n.method).toBe('notifications/claude/channel');
      frames.push(n.params);
    },
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      return {};
    },
    authorId: opts.authorId ?? SELF,
    now: () => FIXED_MS,
  });
  return { frames, sent, messages };
}

/** The one frame a call produced — fails loudly on zero or two. */
export function only(frames: ChannelNotification['params'][]): ChannelNotification['params'] {
  expect(frames).toHaveLength(1);
  return frames[0] as ChannelNotification['params'];
}
