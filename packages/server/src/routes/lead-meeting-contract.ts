/**
 * The contract for the board lead's line into a running meeting (what a
 * contract is: `route-contract.ts`). `workspace-lead-chat.ts` serves it.
 * `say_in_meeting` reads whether the line was said, and played.
 */
import { Hono } from 'hono';
import { answers, json } from './route-contract.ts';

export interface MeetingSayBody {
  agentId: string;
  text: string;
}

/**
 * Held until the speaker finished, then either said or dropped. `lapsed`
 * names why a dropped line was not said.
 */
export type MeetingSayAnswer =
  | { ok: true; said: false; lapsed: string; hint: string }
  | {
      ok: true;
      said: true;
      meetingId: string;
      turn: number;
      waitedMs?: number;
      /** Played aloud only from a microphone meeting's recording tab. */
      played: boolean;
    };

export const leadMeetingContract = new Hono().post(
  '/workspaces/:ws/lead-chat/meeting/say',
  json<MeetingSayBody>(),
  answers<MeetingSayAnswer>(),
);

export type LeadMeetingContract = typeof leadMeetingContract;
