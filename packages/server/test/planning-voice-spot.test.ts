/**
 * The planning voice's cursor is where that agent points, so it is the
 * agent's spot in the workspace's presence room too.
 *
 * An agent's presence is the spot it CHOOSES to point at (Bryan, 15 Oct).
 * The planning voice chooses by putting its cursor (`agentFocus`) on the
 * words it is asking about, so each question moves its spot in the board's
 * room, and an already-open follower hears the move. The voice holds no
 * event stream, so its spot is shown while its cursor is on the doc and goes
 * when the cursor comes off.
 *
 * Over the four-gap plan of `interview-fixture.ts`, in a real `DocStore`,
 * with the board's room as a real `Awareness`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  AGENT_SPOTS_FIELD,
  type AgentSpot,
  parseAgentSpots,
} from '@claude-workspaces/core/workspace-presence';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createAgentSpots } from '../src/agent-spots.ts';
import { PLANNING_VOICE_ID } from '../src/spoken-reply/interview-docs.ts';
import { DOC_ID, type Fixture, WS, planFixture } from './interview-fixture.ts';

let fx: Fixture | null = null;
const rooms: Awareness[] = [];
afterEach(() => {
  fx?.stop();
  fx = null;
  for (const r of rooms.splice(0)) r.destroy();
});

/** The board's room, and the voice's spot as a page in it reads it. */
function boardRoom() {
  const room = new Awareness(new Y.Doc());
  rooms.push(room);
  const spots = createAgentSpots({
    boardsForDoc: () => [WS],
    boardAwareness: () => room,
    surfaceOf: () => 'doc',
    // No agent holds a stream here: the voice is shown on its cursor alone.
    listening: () => false,
  });
  const voice = (): AgentSpot | undefined =>
    parseAgentSpots(room.getLocalState()?.[AGENT_SPOTS_FIELD]).get(PLANNING_VOICE_ID);
  return { spots, voice };
}

function blockText(f: Fixture, id: string | undefined): string | undefined {
  return f.docStore.readOutline(DOC_ID)?.blocks.find((b) => b.id === id)?.text;
}

describe("the planning voice's spot in the workspace room", () => {
  it('moves with each question, and goes when the voice stops asking', async () => {
    const { spots, voice } = boardRoom();
    fx = await planFixture({ spots });

    await fx.say('');
    const first = voice();
    expect(first).toMatchObject({ surface: 'doc', docId: DOC_ID, quote: 'Goals', name: 'Claude' });
    expect(blockText(fx, first?.blockId)).toBe('Goals');

    await fx.say('Cut the crossing to twenty minutes so commuters switch from the bridge.');
    const second = voice();
    expect(second?.quote).toBe('Design');
    expect(blockText(fx, second?.blockId)).toBe('Design');
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);

    await fx.say("that's enough");
    expect(voice()).toBeUndefined();
  });
});
