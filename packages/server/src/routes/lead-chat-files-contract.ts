/**
 * The contract for reading one lead-chat file as JSON (`route-contract.ts`
 * says what a contract is). `workspace-lead-chat-files.ts` serves it;
 * `read_chat_attachment` reads both fields of the answer.
 */
import type { LeadChatAttachment } from '@claude-workspaces/core/lead-chat';
import { Hono } from 'hono';
import { answers, query } from './route-contract.ts';

/** `base64` answers JSON; without it the route answers the bytes. */
export type LeadChatFileQuery = { encoding?: 'base64' };
export interface LeadChatFileAnswer {
  file: LeadChatAttachment;
  /** The bytes, base64. */
  data: string;
}

export const leadChatFilesContract = new Hono().get(
  '/workspaces/:ws/lead-chat/files/:id',
  query<LeadChatFileQuery>(),
  answers<LeadChatFileAnswer>(),
);

export type LeadChatFilesContract = typeof leadChatFilesContract;
