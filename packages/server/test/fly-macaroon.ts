/**
 * A small model of how Fly decides whether a token's caveats allow an access,
 * so a test can ask what a cut token allows rather than what its JSON looks
 * like. It follows superfly/macaroon:
 *
 *   flyio/access.go        an access names an app OR an org feature, never both
 *   resset/resource_set.go ResourceSet.Prohibits: no id of its kind is
 *                          ErrResourceUnspecified; an id it does not list is
 *                          refused; the action must sit inside the listed one
 *   flyio/caveats.go       Apps checks the app id, FeatureSet the feature
 *   resset/if_present.go   IfPresent skips a caveat that answered
 *                          Unspecified; when every one did, `else` decides
 *   caveats.go             ValidityWindow: not_before <= now <= not_after
 *
 * Only the caveats ci-tokens.ts writes are modelled; any other type throws.
 */
import type { Caveat } from '../../../infra/project-machine/ci-tokens.ts';

export interface FlyAccess {
  appId?: string;
  feature?: string;
  /** Letters from `rwcdC`. */
  action: string;
  /** Unix seconds. */
  now: number;
}

const UNSPECIFIED = 'unspecified';
type Verdict = null | typeof UNSPECIFIED | string;

const subset = (action: string, allowed: string) =>
  [...action].every((letter) => allowed.includes(letter));

function resourceSet(set: Record<string, string>, id: string | undefined, action: string): Verdict {
  if (id === undefined) return UNSPECIFIED;
  const ids = Object.keys(set);
  if (ids.includes('0') && ids.length > 1) return 'bad caveat: zero id beside others';
  let perm = 'rwcdC';
  let found = false;
  for (const [entry, allowed] of Object.entries(set)) {
    if (entry === '0' || entry === id) {
      perm = [...perm].filter((l) => allowed.includes(l)).join('');
      found = true;
    }
  }
  if (!found) return `unauthorized for ${id}`;
  return subset(action, perm) ? null : `action ${action} not allowed on ${id}`;
}

function prohibits(c: Caveat, a: FlyAccess): Verdict {
  switch (c.type) {
    case 'Apps':
      return resourceSet(c.body.apps as Record<string, string>, a.appId, a.action);
    case 'FeatureSet':
      return resourceSet(c.body.features as Record<string, string>, a.feature, a.action);
    case 'ValidityWindow': {
      const w = c.body as { not_before: number; not_after: number };
      return a.now >= w.not_before && a.now <= w.not_after ? null : 'outside validity window';
    }
    case 'IfPresent': {
      let ifBranch = false;
      const errors: string[] = [];
      for (const inner of c.body.ifs as Caveat[]) {
        const v = prohibits(inner, a);
        if (v === UNSPECIFIED) continue;
        ifBranch = true;
        if (v !== null) errors.push(v);
      }
      if (!ifBranch && !subset(a.action, c.body.else as string)) return 'else refuses';
      return errors.length ? errors.join('; ') : null;
    }
    default:
      throw new Error(`caveat type not modelled: ${c.type}`);
  }
}

/** Whether a token carrying `set` may make this access. */
export function allows(set: readonly Caveat[], a: FlyAccess): boolean {
  if (a.appId !== undefined && a.feature !== undefined) {
    throw new Error('an access names an app or a feature, never both');
  }
  return set.every((c) => prohibits(c, a) === null);
}
