/** Who is told when an attached app stops answering, and how often (`app-outage.ts`). */
import { describe, expect, it } from 'bun:test';
import { APP_UNREACHABLE_EVENT, type AppFailure, AppOutages } from '../src/app-outage.ts';

const FAILURE: AppFailure = {
  workspaceId: 'w-harbor',
  docId: 'd-harbor',
  title: 'Harborlight site',
  origin: 'http://127.0.0.1:4321',
  prefix: '/workspaces/w-harbor/apps/d-harbor/',
  reason: 'Unable to connect',
  attachedBy: 'agent-harborlight',
};

function harness(opts: { lead?: string; reached?: number } = {}) {
  const sent: Array<{ workspaceId: string; agentId: string; frame: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let t = 1_000;
  const outages = new AppOutages({
    leadOf: () => opts.lead,
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame: { ...frame } });
      return opts.reached ?? 1;
    },
    log: (l) => lines.push(l),
    now: () => t,
  });
  return { outages, sent, lines, advance: (ms: number) => (t += ms) };
}

describe('AppOutages', () => {
  it('tells the attacher once per outage, and again after the app answers', () => {
    const h = harness({ lead: 'agent-riverbend' });
    expect(h.outages.failed(FAILURE)).toBe(true);
    expect(h.outages.failed(FAILURE)).toBe(false);
    expect(h.outages.failed(FAILURE)).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.agentId).toBe('agent-harborlight');
    expect(h.sent[0]?.frame).toMatchObject({
      event: APP_UNREACHABLE_EVENT,
      docId: 'd-harbor',
      origin: FAILURE.origin,
      addressedAs: 'attacher',
    });
    h.advance(90_000);
    h.outages.answered('d-harbor');
    expect(h.lines.at(-1)).toBe('[apps] d-harbor answering again after 90s down');
    expect(h.outages.failed(FAILURE)).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it('keeps each app’s outage separate', () => {
    const h = harness();
    h.outages.failed(FAILURE);
    h.outages.failed({ ...FAILURE, docId: 'd-riverbend' });
    expect(h.sent.map((s) => s.frame.docId)).toEqual(['d-harbor', 'd-riverbend']);
  });

  it('falls back to the board lead when the attach recorded nobody', () => {
    const h = harness({ lead: 'agent-riverbend' });
    const { attachedBy: _, ...unrecorded } = FAILURE;
    h.outages.failed(unrecorded);
    expect(h.sent[0]?.agentId).toBe('agent-riverbend');
    expect(h.sent[0]?.frame.addressedAs).toBe('lead');
  });

  it('logs the outage when there is nobody to tell, and still counts it once', () => {
    const h = harness();
    const { attachedBy: _, ...unrecorded } = FAILURE;
    expect(h.outages.failed(unrecorded)).toBe(true);
    expect(h.outages.failed(unrecorded)).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toStartWith('[apps] d-harbor on w-harbor stopped answering');
    expect(h.lines[0]).toContain('nobody to tell');
  });

  it('says when the addressee holds no stream, so the frame waits for its reconnect', () => {
    const h = harness({ reached: 0 });
    h.outages.failed(FAILURE);
    expect(h.lines[0]).toContain('not listening now');
  });

  it('logs no recovery for an app that was never down', () => {
    const h = harness();
    h.outages.answered('d-harbor');
    expect(h.lines).toHaveLength(0);
  });
});
