/**
 * The person verbs as `tools/list` advertises them. Spread into `TOOL_LIST`
 * (`tool-schemas.ts`); the behaviour is `tools/person.ts`. The place fields
 * are `point_at`'s, so the two verbs name a place the same way.
 */
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

export const PERSON_TOOLS: ListToolsResult['tools'] = [
  {
    name: 'watch_person',
    description:
      "Hear where the board's owner is looking. While on, a person.landed line arrives each time the tab they are attending to (visible and focused) lands on another page of this board: a doc, diff, mock, app, whiteboard, task, goal or board page, with the place in view. A scroll within a page is not a landing. The reply says where they are now (landing, or null when no tab of theirs on this board is in front of them). Live only: nothing is queued while your session is away. on:false stops it.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'The board to watch.' },
        on: { type: 'boolean', description: 'false stops the watch. Default true.' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'show_person',
    description:
      "Take the board owner's tab to a place on this board, when they asked you to show them something. Only the tab they are attending to moves: a tab in the background or on another device stays where it is. Name the place as point_at does. shown:false with error not-here means no tab of theirs on this board is in front of them; post the link on the task instead. Use point_at, not this, to move people who chose to follow you.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'The board the place is on.' },
        path: {
          type: 'string',
          description:
            "A page of the board, relative to it: 'home', 'tasks', 'library', 'activity', 'home?item=<key>', '?task=<id>&tab=activity', 'library?list=files', '?settings=prompts'. Or '/review' for the review queue or '/' for the workspaces list. Any path also takes scroll.",
        },
        taskId: { type: 'string', description: 'A task: opens its panel.' },
        goalId: { type: 'string', description: 'A goal: opens its panel.' },
        docId: {
          type: 'string',
          description: 'A doc, mock, app, whiteboard, or a file of a diff or folder on the board.',
        },
        threadId: {
          type: 'string',
          description: 'A thread on the task, goal or doc named, opened where it is.',
        },
        blockId: { type: 'string', description: 'A block of the doc, centred on screen.' },
        quote: {
          type: 'string',
          description:
            'Words in the doc or mock, found and centred on screen. At most 500 characters.',
        },
        scroll: {
          type: 'number',
          description: 'How far down the doc or page: 0 is the top, 1 the bottom.',
        },
        x: { type: 'number', description: 'Whiteboard canvas x.' },
        y: { type: 'number', description: 'Whiteboard canvas y.' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'confirm_person',
    description:
      'Confirm which person you work for, by their sign-in email. You become their lead agent only once they have also named you in their profile; until then the reply says pending. Their private messages reach only their linked lead agent. email: null clears your side of the link.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: ['string', 'null'],
          description: "The person's sign-in email, or null to clear the link.",
        },
      },
      required: ['email'],
    },
  },
];
