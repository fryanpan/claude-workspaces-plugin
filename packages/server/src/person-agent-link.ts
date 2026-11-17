/**
 * Each person names one agent as their lead agent, and the link holds only
 * when that agent confirms the same person.
 *
 * Two sides, stored apart: the person's choice (`named`) and the agent's
 * (`confirmed`). The link is active when both name each other, in either
 * order. If one side could claim alone, Bob could name Alice's agent and make
 * it "his" for the token ceiling and private messages, or an agent could be
 * pointed at somebody else's private messages. Clearing either side unlinks.
 *
 * Kept beside `identities.ts` rather than inside it: that store sanitizes each
 * row to a fixed shape, and a link is a relation between two rows, not a
 * field of either. Stored in `<dataDir>/person-agent-links.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SHARED_AGENT_IDS } from './agent-watches.ts';
import type { Identities } from './identities.ts';

const FILENAME = 'person-agent-links.json';

interface FileShape {
  version: 1;
  /** personId → the agent that person named. */
  named: Record<string, string>;
  /** agentId → the person that agent confirmed. */
  confirmed: Record<string, string>;
}

/** Why a link change was refused. */
export type LinkRefusal =
  | 'not_a_person'
  | 'not_an_agent'
  | 'archived'
  | 'shared_agent'
  | 'agent_claimed';

export type LinkResult =
  | { ok: true; state: 'linked' | 'pending' | 'cleared' }
  | { ok: false; error: LinkRefusal };

export class PersonAgentLinks {
  private readonly path: string;
  private state: FileShape = { version: 1, named: {}, confirmed: {} };

  constructor(
    dataDir: string,
    private readonly identities: Identities,
  ) {
    this.path = join(dataDir, FILENAME);
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      this.state = {
        version: 1,
        named: stringMap(parsed.named),
        confirmed: stringMap(parsed.confirmed),
      };
    } catch (err) {
      console.error(`[person-agent-links] unreadable, starting empty: ${String(err)}`);
    }
  }

  /** The person's side: name `agentId` as my lead agent, or clear it. */
  nameLeadAgent(personId: string, agentId: string | null): LinkResult {
    const person = this.identities.get(personId);
    if (!person || person.kind !== 'person') return { ok: false, error: 'not_a_person' };
    if (person.status !== 'active') return { ok: false, error: 'archived' };
    if (agentId === null) {
      if (!(person.id in this.state.named)) return { ok: true, state: 'cleared' };
      delete this.state.named[person.id];
      this.save();
      return { ok: true, state: 'cleared' };
    }
    const agent = this.checkAgent(agentId);
    if ('error' in agent) return { ok: false, error: agent.error };
    const holder = this.personOfAgent(agent.id);
    if (holder !== null && holder !== person.id) return { ok: false, error: 'agent_claimed' };
    this.state.named[person.id] = agent.id;
    this.save();
    return { ok: true, state: this.state.confirmed[agent.id] === person.id ? 'linked' : 'pending' };
  }

  /** The agent's side: confirm `personId` as my person, or clear it. */
  confirmPerson(agentId: string, personId: string | null): LinkResult {
    const agent = this.checkAgent(agentId);
    if ('error' in agent) return { ok: false, error: agent.error };
    if (personId === null) {
      if (!(agent.id in this.state.confirmed)) return { ok: true, state: 'cleared' };
      delete this.state.confirmed[agent.id];
      this.save();
      return { ok: true, state: 'cleared' };
    }
    const person = this.identities.get(personId);
    if (!person || person.kind !== 'person') return { ok: false, error: 'not_a_person' };
    if (person.status !== 'active') return { ok: false, error: 'archived' };
    this.state.confirmed[agent.id] = person.id;
    this.save();
    return { ok: true, state: this.state.named[person.id] === agent.id ? 'linked' : 'pending' };
  }

  /** The person this agent is linked to, only when both sides agree. */
  personOfAgent(agentId: string): string | null {
    const personId = this.state.confirmed[agentId];
    if (personId === undefined || this.state.named[personId] !== agentId) return null;
    return this.live(personId) && this.live(agentId) ? personId : null;
  }

  /** The lead agent this person is linked to, only when both sides agree. */
  leadAgentOf(personId: string): string | null {
    const agentId = this.state.named[personId];
    if (agentId === undefined) return null;
    return this.personOfAgent(agentId) === personId ? agentId : null;
  }

  /** What each side has said, for the person's own profile read. */
  sidesOf(personId: string): { named: string | null; linked: string | null } {
    return { named: this.state.named[personId] ?? null, linked: this.leadAgentOf(personId) };
  }

  private live(id: string): boolean {
    return this.identities.get(id)?.status === 'active';
  }

  private checkAgent(agentId: string): { id: string } | { error: LinkRefusal } {
    if (SHARED_AGENT_IDS.has(agentId)) return { error: 'shared_agent' };
    const agent = this.identities.get(agentId);
    if (!agent || agent.kind !== 'agent') return { error: 'not_an_agent' };
    if (agent.status !== 'active') return { error: 'archived' };
    return { id: agent.id };
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}
