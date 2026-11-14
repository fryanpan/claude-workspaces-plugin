/**
 * The component tools as `tools/list` advertises them. Spread into
 * `TOOL_LIST` (`tool-schemas.ts`); the behaviour is `tools/components.ts`,
 * and the rules are the server's `doc-components-agent.ts`.
 */
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

const WORKSPACE_ID = { type: 'string', description: 'The board the doc is on.' } as const;
const DOC_ID = {
  type: 'string',
  description: 'The doc, bound to an .mdx file, whose components these are.',
} as const;
const COMPONENT_ID = {
  type: 'string',
  description:
    'The state id: the string `id` prop on the tag. 1 to 64 of a-z, 0-9 and -. list_components names them.',
} as const;
const PATH = {
  type: 'string',
  description: 'A dot path into the state, like "pins.harborlight" or "log.0".',
} as const;

const RUNS =
  'Every component runs in the doc page for every reader, with the reader’s session; none is framed.';

export const COMPONENT_TOOLS: ListToolsResult['tools'] = [
  {
    name: 'list_components',
    description: `List an .mdx doc's components: one row per tag, with its state ids, its build status (built, failed with the error, or pending) and whether it has state; then one row per state no tag names, marked placed:false (deleting a tag keeps its state). ${RUNS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, docId: DOC_ID },
      required: ['workspaceId', 'docId'],
    },
  },
  {
    name: 'get_component_state',
    description:
      "Read a component's state: the whole state, or the value at `path`. Says whether a tag in the doc still names the id.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        componentId: COMPONENT_ID,
        path: PATH,
      },
      required: ['workspaceId', 'docId', 'componentId'],
    },
  },
  {
    name: 'set_component_state',
    description:
      "Change a component's state in one step. Every open page shows the change within a second. `ops` is a list of at most 100 of {op:'set', path, value}, {op:'push', path, value} (append to a list) and {op:'delete', path}. The list is checked whole against the page's limits (256 KB per component, 2 MB per doc, depth 8, 20 writes a second) and applied in full or not at all. Returns the state after.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        componentId: COMPONENT_ID,
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'push', 'delete'] },
              path: PATH,
              value: { description: 'Any JSON value. Not used by delete.' },
            },
            required: ['op', 'path'],
          },
        },
      },
      required: ['workspaceId', 'docId', 'componentId', 'ops'],
    },
  },
  {
    name: 'place_component',
    description: `Insert a component tag into an .mdx doc, under a heading or at the end, with its import line when the doc has none for that file, and build it. Returns the tag as written and the build status; a failed build says why. A local file must be in the doc's git repository under a folder holding component.json; a file git ignores builds only after request_component_grant is approved. ${RUNS}`,
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        importPath: {
          type: 'string',
          description:
            "A path relative to the doc, ending .ts, .tsx, .js, .jsx or .mjs (like './map/index.ts'), or an esm.sh URL at an exact version.",
        },
        name: {
          type: 'string',
          description: 'The tag name. Default: from the file name, like Map for ./map/index.ts.',
        },
        props: {
          type: 'object',
          description:
            'The tag’s props, which must include a string `id`: the state id. Strings are written as "…"; anything else as {JSON}.',
        },
        headingId: {
          type: 'string',
          description:
            'Insert under this heading (an id read_doc_outline returned). Default: the end.',
        },
      },
      required: ['workspaceId', 'docId', 'importPath', 'props'],
    },
  },
  {
    name: 'request_component_grant',
    description:
      "Ask the owner to let docs build components from a folder's files that git ignores. Files an access card on the task you name and changes nothing; you are told when the owner answers. The folder must be inside the doc's git repository and declared by a component.json. A grant covers that folder for docs on every board.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        folder: { type: 'string', description: 'Relative to the doc, or absolute.' },
        taskId: { type: 'string', description: 'The task that needs it; the card is filed there.' },
        why: {
          type: 'string',
          description: 'What the component is for, in at most 600 characters.',
        },
      },
      required: ['workspaceId', 'docId', 'folder', 'taskId', 'why'],
    },
  },
];
