/**
 * A speaker with no display name says "assign this to me".
 *
 * `VoiceActor.name` is typed as a required string, so nothing in the compiler
 * objects. The value does not come from the compiler: it arrives on the
 * request body and passes through `authorFor`, which hands an author the
 * roster does not know back exactly as claimed. `{"author":{"id":"x"}}` is
 * enough to reach `resolveVoiceAction` with `name: undefined`.
 *
 * Two sites in the self-assignment path then called a string method on it —
 * `actor.name.toLowerCase()` in the licence check and `assignee.trim()` in
 * the plan — and threw. `voice.ts` promises the opposite in as many words:
 * "Never throws for a live workspace: every failure mode degrades to the
 * agent route." A malformed author turned that into a 500.
 *
 * Sibling of `nameless-actor.test.ts`, which is the same defect one layer
 * down in the task store. The bar here is narrower than "do not throw": a
 * nameless speaker must still be able to set a status and leave a comment,
 * because neither of those needs to know who they are. Only "me" cannot be
 * resolved, and refusing it takes the utterance to the agent route, which is
 * where every other refusal in this module already sends it.
 */
import { describe, expect, it } from 'bun:test';
import { resolveVoiceAction } from '../src/voice-action.ts';
import { type VoiceContext, type VoiceResource, parseVoiceReply } from '../src/voice-prompt.ts';

/** An author the roster does not know, as `authorFor` passes it through: an
 *  id, a kind, and no name at all. Cast because the wire shape is looser than
 *  the type — which is the whole reason this file exists. */
const NAMELESS = { id: 'known-nobody', kind: 'known' } as unknown as {
  id: string;
  name: string;
  kind: string;
};
const NAMED = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

const TASK_CONTEXT: VoiceContext = { surface: 'task', taskId: 't-fixture' };
const RESOURCE: VoiceResource = {
  kind: 'task',
  id: 't-fixture',
  title: 'Wire the results page',
  status: 'todo',
  assignee: '',
  links: [],
};

const resolve = (
  raw: string,
  transcript: string,
  actor: { id: string; name: string; kind: string },
) =>
  resolveVoiceAction({
    classification: parseVoiceReply(raw),
    actor,
    transcript,
    context: TASK_CONTEXT,
    resource: RESOURCE,
  });

const ASSIGN_SELF = '{"kind":"action","action":"set-assignee","assignee":"me","id":"t-fixture"}';
const MARK_DONE = '{"kind":"action","action":"set-status","status":"done","id":"t-fixture"}';
const COMMENT = '{"kind":"action","action":"comment","id":"t-fixture"}';

describe('a speaker the roster has no name for', () => {
  it('POSITIVE CONTROL: a named speaker still resolves "assign this to me"', () => {
    // Without this the whole file could pass because nothing resolves at all.
    // Note the transcript avoids the word "me" so the licence check has to
    // reach the name-matching branch — the one that used to throw.
    expect(resolve(ASSIGN_SELF, 'jordan takes this one', NAMED)).toEqual({
      action: 'set-assignee',
      taskId: 't-fixture',
      assignee: 'Jordan',
      actor: NAMED,
    });
  });

  it('does not throw when the licence check has to compare against their name', () => {
    // The pre-fix line was `said.includes(actor.name.toLowerCase())`, reached
    // only when the transcript carries no self word — hence a transcript with
    // none. Before the fix this threw TypeError rather than returning.
    expect(() => resolve(ASSIGN_SELF, 'hand this one over', NAMELESS)).not.toThrow();
  });

  it('refuses to resolve "me" rather than assigning the row to nobody', () => {
    // Both spellings: with a self word in the transcript, the licence check
    // passes and the PLAN site is what has to refuse; without one, the licence
    // check itself refuses. Either way the answer is null, which is this
    // module's word for "take the agent route".
    expect(resolve(ASSIGN_SELF, 'assign this to me', NAMELESS)).toBeNull();
    expect(resolve(ASSIGN_SELF, 'hand this one over', NAMELESS)).toBeNull();
  });

  it('still lets them set a status — that verb never needed their name', () => {
    expect(resolve(MARK_DONE, 'mark this done', NAMELESS)).toEqual({
      action: 'set-status',
      taskId: 't-fixture',
      status: 'done',
      actor: NAMELESS,
    });
  });

  it('still lets them comment', () => {
    const plan = resolve(COMMENT, 'this needs a second look', NAMELESS);
    expect(plan).toMatchObject({ action: 'comment', text: 'this needs a second look' });
  });

  it('a named speaker assigning somebody ELSE is untouched by the guard', () => {
    const raw = '{"kind":"action","action":"set-assignee","assignee":"Riverbend","id":"t-fixture"}';
    expect(resolve(raw, 'give this to riverbend', NAMED)).toMatchObject({
      action: 'set-assignee',
      assignee: 'Riverbend',
    });
  });
});
