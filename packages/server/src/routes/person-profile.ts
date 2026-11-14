/**
 * `POST /api/auth/profile`: a signed-in person sets their own display name
 * and names their one lead agent.
 *
 * Whose profile is decided by the proof alone, never the body: an Access
 * assertion or a session cookie (`provenIdentityFor`). A request carrying any
 * `Authorization` header is refused, which covers the widget token and both
 * agent tokens: none of them is a person at their own browser. The global
 * write gate already refused a cross-origin credentialed request.
 *
 * Naming an agent is the person's half of the link; it is active only when
 * the agent confirms (`person-agent-link.ts`).
 */
import { type Identities, type IdentityRecord, userForIdentity } from '../identities.ts';
import type { PersonAgentLinks } from '../person-agent-link.ts';

export interface PersonProfileContext {
  identities: Identities;
  personAgentLinks: PersonAgentLinks;
  onPersonRenamed: (personId: string, name: string) => void;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

export async function handleProfile(
  ctx: PersonProfileContext,
  req: Request,
  provenIdentityFor: () => IdentityRecord | null,
): Promise<Response> {
  const { identities, personAgentLinks, j, safeJson } = ctx;
  if (req.headers.has('authorization')) return j(403, { error: 'person_proof_required' });
  const rec = provenIdentityFor();
  if (!rec || rec.kind !== 'person') return j(401, { error: 'not_signed_in' });
  const body = await safeJson(req);
  const hasName = typeof body?.displayName === 'string';
  const hasAgent = body !== null && 'leadAgentId' in body;
  if (!hasName && !hasAgent) return j(400, { error: 'nothing_to_change' });
  let updated: IdentityRecord | null = rec;
  if (hasName) {
    const displayName = String(body?.displayName).trim();
    if (!displayName) return j(400, { error: 'invalid_display_name' });
    updated = identities.setDisplayName(rec.id, displayName);
    if (!updated) return j(401, { error: 'not_signed_in' });
  }
  if (hasAgent) {
    const raw = body?.leadAgentId;
    if (raw !== null && (typeof raw !== 'string' || !raw.trim() || raw.length > 200)) {
      return j(400, { error: 'invalid_lead_agent' });
    }
    const linked = personAgentLinks.nameLeadAgent(rec.id, raw === null ? null : raw.trim());
    if (!linked.ok) return j(linked.error === 'agent_claimed' ? 409 : 400, { error: linked.error });
  }
  if (hasName && updated) ctx.onPersonRenamed(updated.id, updated.displayName);
  return j(200, {
    ok: true,
    user: userForIdentity(updated ?? rec),
    leadAgent: personAgentLinks.sidesOf(rec.id),
  });
}
