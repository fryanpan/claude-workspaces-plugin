/**
 * The coach session's feed: a frame is addressed on the Coach board to its
 * lead, and only while that lead holds a stream, so a session that is gone
 * returns to no backlog.
 */
import { describe, expect, it } from 'bun:test';
import { SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';

function feed(opts: { lead?: boolean; connected?: boolean; took?: number } = {}) {
  const sent: [string, string, SessionFrame][] = [];
  const f = new SessionFeed({
    lead: () => (opts.lead === false ? null : { workspaceId: 'w-coach', agentId: 'agent-coach' }),
    connected: () => opts.connected ?? true,
    send: (ws, agent, frame) => {
      sent.push([ws, agent, frame]);
      return opts.took ?? 1;
    },
  });
  return { f, sent };
}

describe('SessionFeed', () => {
  it('addresses each frame to the lead on the Coach board, stamped with its time', () => {
    const { f, sent } = feed();
    expect(f.reachable()).toBe(true);
    expect(f.send({ event: 'coach.preference', readiness: 'more' }, 42)).toBe(true);
    expect(sent).toEqual([
      [
        'w-coach',
        'agent-coach',
        { event: 'coach.preference', readiness: 'more', workspaceId: 'w-coach', at: 42 },
      ],
    ]);
  });

  it('sends nothing with no lead or a lead holding no stream, and says when no stream took it', () => {
    for (const opts of [{ lead: false }, { connected: false }]) {
      const { f, sent } = feed(opts);
      expect(f.reachable()).toBe(false);
      expect(f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(false);
      expect(sent).toEqual([]);
    }
    expect(feed({ took: 0 }).f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(
      false,
    );
  });
});
