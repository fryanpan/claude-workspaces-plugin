/**
 * The lead's status on the home feed: what the board's server reports
 * (`leadStatusOf`) and what the Mac keeps of a remote's report (`readLead`).
 * The two-server path is `remote-escalation-across-servers.test.ts`.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { readLead } from '../src/home-feed.ts';
import { type LeadStatusSource, leadStatusOf } from '../src/lead-status.ts';

const source = (over: Partial<LeadStatusSource> = {}): LeadStatusSource => ({
  getWorkspace: () => ({ leadAgentId: 'agent-riverbend-lead' }),
  hasLiveAttachmentFor: () => true,
  listAttachments: () => [
    { agentId: 'agent-other', lastHeartbeat: 5, lastToolCallAt: 5 },
    { agentId: 'agent-riverbend-lead', lastHeartbeat: 300, lastToolCallAt: 200 },
  ],
  ...over,
});

describe('leadStatusOf', () => {
  it('reports the lead seat’s own attachment', () => {
    expect(leadStatusOf(source(), 'w-riverbend')).toEqual({
      agentId: 'agent-riverbend-lead',
      live: true,
      lastSeenAt: 300,
      lastToolCallAt: 200,
    });
  });

  it('says not live, with no times, for a lead never attached', () => {
    const s = source({ hasLiveAttachmentFor: () => false, listAttachments: () => [] });
    expect(leadStatusOf(s, 'w-riverbend')).toEqual({
      agentId: 'agent-riverbend-lead',
      live: false,
    });
  });

  it('reports nothing for a board with no lead', () => {
    expect(leadStatusOf(source({ getWorkspace: () => ({}) }), 'w-riverbend')).toBeUndefined();
  });
});

describe('readLead', () => {
  it('keeps a well-formed report', () => {
    const lead = { agentId: 'agent-riverbend-lead', live: false, lastSeenAt: 1_700_000_000_000 };
    expect(readLead(lead)).toEqual(lead);
  });

  it('drops a report whose live is not a boolean, and a bad id or time alone', () => {
    expect(readLead({ agentId: 'agent-riverbend-lead', live: 'yes' })).toBeUndefined();
    expect(readLead(null)).toBeUndefined();
    expect(readLead(['live'])).toBeUndefined();
    expect(
      readLead({ agentId: 'agent-‮evil', live: true, lastSeenAt: 'soon', lastToolCallAt: -1 }),
    ).toEqual({ live: true });
  });
});
