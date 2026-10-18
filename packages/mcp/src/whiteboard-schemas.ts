/**
 * The whiteboard verbs as `tools/list` advertises them. Spread into
 * `TOOL_LIST` (`tool-schemas.ts`); the behaviour is `tools/whiteboard.ts`.
 */
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

const WORKSPACE_ID = {
  type: 'string',
  description:
    'The board this whiteboard is on. get_workspace lists the boards you are attached to.',
} as const;

const SHAPE = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Your name for the shape (letters, digits, - and _). Reusing an id already on the board replaces that shape. Omit for a new one; the reply names the id given.',
    },
    kind: { type: 'string', enum: ['box', 'ellipse', 'arrow', 'text'] },
    x: { type: 'number', description: 'Left edge, in canvas units.' },
    y: { type: 'number', description: 'Top edge, in canvas units.' },
    w: { type: 'number', description: 'Width. Defaults: box 160, ellipse 140, arrow 120.' },
    h: { type: 'number', description: 'Height. Defaults: box 80, ellipse 90, arrow 0.' },
    text: {
      type: 'string',
      description: 'The words: a box or ellipse shows them inside; required for text.',
    },
    from: { type: 'string', description: 'Arrow only: the id of the shape it starts at.' },
    to: { type: 'string', description: 'Arrow only: the id of the shape it points to.' },
  },
  required: ['kind', 'x', 'y'],
} as const;

export const WHITEBOARD_TOOLS: ListToolsResult['tools'] = [
  {
    name: 'create_whiteboard',
    description:
      'Create a live whiteboard on a board and watch it. Returns {docId, url}; share the url. People draw on it in the browser and you draw with draw_on_whiteboard. When a person finishes a change, you get one whiteboard.changed event about 1.5s after their pen rests, naming the shapes they changed; your own drawing never comes back to you. Returns `url`, the absolute link to the whiteboard. Give that link to a person.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, title: { type: 'string' } },
      required: ['workspaceId'],
    },
  },
  {
    name: 'draw_on_whiteboard',
    description:
      'Draw boxes, ellipses, arrows and text on a whiteboard. mode "add" (the default) draws over what is there, a shape whose id is already on the board replacing it; mode "replace" makes the board hold exactly these shapes and deletes the rest. Pass point {x, y} to show people where you are looking, labelled with your name; null clears it, omitted leaves it. Your presence on the canvas is only that point, never your last stroke. Returns the ids written and the element count. At most 200 shapes per call.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: { type: 'string' },
        shapes: { type: 'array', items: SHAPE },
        mode: { type: 'string', enum: ['add', 'replace'] },
        point: {
          type: ['object', 'null'],
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
      },
      required: ['workspaceId', 'docId', 'shapes'],
    },
  },
  {
    name: 'get_whiteboard',
    description:
      'Read a whiteboard as shapes: {shapes: [{id, kind, x, y, w, h, text, from, to}], count}. A box\'s words are its text. A person\'s pen stroke reads kind "freedraw" with its bounding box.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, docId: { type: 'string' } },
      required: ['workspaceId', 'docId'],
    },
  },
];
