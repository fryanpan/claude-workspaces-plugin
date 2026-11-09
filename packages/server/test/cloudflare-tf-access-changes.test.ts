/**
 * Who a saved plan adds to or removes from each project's Access sign-in
 * list (`infra/cloudflare/access-changes.ts`), read from the plan's JSON
 * because the plan text prints `(sensitive value)` there.
 */
import { describe, expect, it } from 'bun:test';
import { accessChanges } from '../../../infra/cloudflare/access-changes.ts';

const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';
const email = (e: string) => ({ email: { email: e }, email_domain: null });
const domain = (d: string) => ({ email: null, email_domain: { domain: d } });

const people = (index: string, actions: string[], before: unknown, after: unknown) => ({
  address: `module.stack.module.access.cloudflare_zero_trust_access_policy.people["${index}"]`,
  mode: 'managed',
  type: 'cloudflare_zero_trust_access_policy',
  name: 'people',
  index,
  change: { actions, before, after },
});
const plan = (...rc: unknown[]) => JSON.stringify({ resource_changes: rc });

describe('accessChanges', () => {
  it('names each address added and removed, per project', () => {
    const r = accessChanges(
      plan(
        people('saltmarsh', ['update'], { include: [email(BOB)] }, { include: [email(ALICE)] }),
        people('riverbend', ['update'], { include: [] }, { include: [domain('harborlight.test')] }),
      ),
    );
    expect(r).toEqual([
      { project: 'riverbend', added: ['anyone at @harborlight.test'], removed: [] },
      { project: 'saltmarsh', added: [ALICE], removed: [BOB] },
    ]);
  });

  it('counts a new policy as all added and a removed one as all removed', () => {
    const r = accessChanges(
      plan(
        people('riverbend', ['create'], null, { include: [email(ALICE)] }),
        people('saltmarsh', ['delete'], { include: [email(BOB)] }, null),
      ),
    );
    expect(r).toEqual([
      { project: 'riverbend', added: [ALICE], removed: [] },
      { project: 'saltmarsh', added: [], removed: [BOB] },
    ]);
  });

  it('skips a policy whose list is unchanged, and every other resource', () => {
    const same = { include: [email(ALICE)] };
    const r = accessChanges(
      plan(people('riverbend', ['update'], same, same), {
        type: 'cloudflare_zero_trust_access_policy',
        name: 'service_tokens',
        index: 'riverbend',
        change: { actions: ['create'], before: null, after: { include: [] } },
      }),
    );
    expect(r).toEqual([]);
  });

  it('shows a rule shape the module does not write rather than dropping it', () => {
    const r = accessChanges(
      plan(people('riverbend', ['update'], { include: [] }, { include: [{ everyone: {} }] })),
    );
    expect(r[0]?.added).toEqual(['rule {"everyone":{}}']);
  });

  it('refuses a changed policy whose list the plan does not hold', () => {
    expect(() => accessChanges(plan(people('riverbend', ['update'], { include: [] }, {})))).toThrow(
      'the plan does not say who can sign in to riverbend',
    );
  });
});
