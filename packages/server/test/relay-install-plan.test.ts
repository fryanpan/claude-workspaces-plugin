/**
 * The pure half of `relay:install` (`infra/org-relay/install-plan.ts`): the
 * seat list's checks, which servers need an Access service token, and the
 * dry run's redaction. The install itself is `relay-install.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { parseArgs } from '../../../infra/org-relay/install-cli.ts';
import {
  localOutputs,
  parseSeatList,
  redacted,
  serverPlans,
} from '../../../infra/org-relay/install-plan.ts';

const RELAY = 'agent-relay';
const OWNER = 'owner@harborlight.test';
const HOST = 'riverbend.example';
const SEATS = JSON.stringify({
  relayAgentId: RELAY,
  macOrganization: 'harborlight',
  seats: [
    { id: 'team-lead', server: 'mac', agentId: 'agent-team-lead', crossOrganization: true },
    { id: 'riverbend-lead', project: 'riverbend', restartFrom: ['team-lead'] },
  ],
});
const OUTPUTS: TfOutputs = {
  access: {},
  accessTeamDomain: null,
  tunnels: {
    riverbend: { account_id: 'a', id: 't', name: 'riverbend', origin: 'o', public_host: HOST },
  },
};

describe('relay:install plan', () => {
  const list = (extra: Record<string, unknown> = {}) =>
    parseSeatList(
      JSON.stringify({
        relayAgentId: RELAY,
        macOrganization: 'harborlight',
        seats: [{ id: 'riverbend-lead', project: 'riverbend', ...extra }],
      }),
      ['riverbend'],
    );
  const access = { ...OUTPUTS, access: { riverbend: { aud: 'x', hosts: [HOST] } } };

  it('a server behind Access needs the seat to name its service token', () => {
    expect(() => serverPlans(list(), access)).toThrow('accessToken');
    expect(serverPlans(list({ accessToken: 'relay riverbend' }), access)[0]).toMatchObject({
      accessInFront: true,
      accessToken: 'relay riverbend',
    });
    expect(serverPlans(list(), OUTPUTS)[0]?.accessInFront).toBe(false);
  });

  it('refuses a project machines.json does not list, and a restartFrom seat that does not exist', () => {
    expect(() => parseSeatList(SEATS, [])).toThrow('machines.json');
    expect(() => list({ restartFrom: ['nobody'] })).toThrow('restartFrom');
  });

  it('redacts token values and the service secret, keeping the record id', () => {
    const text = redacted(
      '{"bearers": {"w": "at2.rec1.agent-relay.w.99.MAC"}, "clientSecret": "s3cret"}',
    );
    expect(text).toContain('at2.rec1.<redacted>');
    expect(text).not.toContain('MAC');
    expect(text).not.toContain('s3cret');
  });

  it('--no-terraform-outputs takes each host and Access from the files Terraform is given', () => {
    expect(parseArgs(['--no-terraform-outputs']).noOutputs).toBe(true);
    expect(parseArgs([]).noOutputs).toBeUndefined();
    const router = {
      zone: 'example.test',
      oneAddress: 'boards.example.test',
      projects: { riverbend: 'riverbend-origin.example.test' },
      boards: {},
    };
    const files = (access: unknown): Record<string, string> => ({
      'infra/board-router-worker/router.local.json': JSON.stringify(router),
      'infra/access-apps/access.local.json': JSON.stringify(access),
    });
    const plan = (f: Record<string, string>, extra: Record<string, unknown> = {}) =>
      serverPlans(
        list(extra),
        localOutputs((p) => f[p] ?? null),
      )[0];
    expect(plan(files({ projects: {} }))).toMatchObject({
      baseUrl: 'https://riverbend-boards.example.test',
      accessInFront: false,
    });
    const behind = files({
      projects: { riverbend: { hosts: ['riverbend-boards.example.test'], emails: [OWNER] } },
    });
    expect(plan(behind, { accessToken: 'relay riverbend' })?.accessInFront).toBe(true);
    expect(() => localOutputs(() => null)).toThrow('router.local.json, and this checkout has none');
    const { 'infra/access-apps/access.local.json': _, ...noAccess } = files({});
    expect(() => plan(noAccess)).toThrow('access.local.json, and this checkout has none');
  });
});
