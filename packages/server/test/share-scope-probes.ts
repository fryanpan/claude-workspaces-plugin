/**
 * Every (method, path, board) a share visitor's request is judged on in
 * `share-scope-parity.test.ts`, and the board each id in them belongs to.
 *
 * The probes are the vocabulary of the hand-written allowlist the route table
 * replaced: every sub-path it named, under every collection it named them
 * for, with ids on the shared board, on another board, on none and empty, the board
 * segment spelled plainly and percent-encoded, and keys that resolve up
 * `Object.prototype`. FROZEN on purpose, and independent of the route table:
 * a path the old guard admitted but no row names shows up as a difference
 * rather than vanishing with the row, and adding a row later does not change
 * what this file asks. Each row's own example is `route-table.test.ts`'s.
 */
import type { ShareTarget } from '../src/middleware/host-guard.ts';

export const SHARED = 'w-shared';
export const OTHER = 'w-other';

/** Ids on the shared board, ids on another board, and ids on none. */
const OWNERS: Readonly<Record<string, readonly string[]>> = {
  'doc-1': [SHARED],
  'task:t-1': [SHARED],
  'task:g-1': [SHARED],
  'rev-1': [SHARED],
  'doc-other': [OTHER],
  'task:t-other': [OTHER],
  'task:g-other': [OTHER],
  'rev-other': [OTHER],
};

export const workspacesOf = (id: string): string[] =>
  Object.hasOwn(OWNERS, id) ? [...(OWNERS[id] as readonly string[])] : [];

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** The targets a probe is judged under. The NUL one is `collabScope`'s shell sentinel. */
export const TARGETS: Readonly<Record<string, ShareTarget>> = {
  shared: { workspaceId: SHARED },
  none: {},
  shell: { workspaceId: '\u0000collab-no-workspace' },
};

/** Sub-paths of `/workspaces/<board>/` the old allowlist named, verb by verb. */
const OLD_BOARD_SUBS = [
  '',
  'manifest.webmanifest',
  'review-items',
  'review-items/viewed',
  'tasks',
  'home',
  'mine',
  'activity',
  'library',
  'library/items',
  'library/open',
  'home/read',
  'home/instructions',
  'goals/add',
  'goals/rename',
  'goals/reorder',
  'docs:attach',
  'docs',
  'y',
  'huddles',
  'settings',
  'embeds',
  'events',
  'load-reports',
  'members',
  'agents',
  'attachments',
  'events:stream',
  'me/events:stream',
  'me/dm',
  'apps',
  'toString',
  '__proto__',
  'constructor',
];

const OLD_TASK_VERBS = [
  '',
  'detail',
  'transition',
  'evidence',
  'goal',
  'after',
  'title',
  'body',
  'assignee',
  'due',
  'park',
  'archive',
  'restore',
  'answer',
  'answer/undo',
  'more-info',
  'links',
  'review-items',
  'review-items/ri-1/answer',
  'review-items/ri-1/more-info',
  'review-items/ri-1/release',
  'review-items/ri-1/revise',
  'review-items/ri-1/withdraw',
  'review-items/ri-1/withdraw/undo',
  'review-items/ri-1',
  'review-items//answer',
  'review-items/viewed',
  'constructor',
];

const OLD_GOAL_VERBS = ['', 'cascade', 'archive', 'restore', 'rename', 'toString'];

const OLD_ATTACHMENT_VERBS = [
  '',
  'tree',
  'grouped',
  'threads',
  'files',
  'context-file',
  'editable-file',
  'raw',
  'refresh',
  'groups',
  'archive',
  'unarchive',
  '__proto__',
];

const OLD_DOC_VERBS = [
  '',
  'diff',
  'content',
  'status',
  'tasks',
  'activity',
  'lead-presence',
  'meetings',
  'meetings/m-1',
  'meetings/m-1/speakers',
  'meetings/',
  'meetings//speakers',
  'meeting-bot',
  'assets',
  'assets/a.png',
  'assets/sub/a.png',
  'files/page.html',
  'map-key/google',
  'components/c.js',
  'threads',
  'threads/by_find',
  'threads/th-1',
  'threads/th-1/comments',
  'threads/th-1/resolve',
  'threads/th-1/promote',
  'threads/th-1/rewrite_region',
  'threads/th-1/withdraw',
  'threads/th-1/summary',
  'threads/th-1/linked-items',
  'threads/th-1/anything',
  'threads/',
  'threads//comments',
  'threads//resolve',
  'suggestions',
  'suggestions/resolve_all',
  'suggestions/s-1/accept',
  'suggestions/s-1/reject',
  'suggestions//accept',
  'y',
  'audio',
  'events:stream',
  'reparse_from_disk',
  'archive',
  'nothing-here',
];

const SHELL_PATHS = [
  '/',
  '/app',
  '/app/',
  '/app/main.js',
  '/widget.js',
  '/widget.iife.js',
  '/widget.esm.js',
  '/widget/x.js',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/sw.js',
  '/api/auth/session',
  '/api/meeting-engines',
  '/api/share',
  '/workspaces',
  '/workspaces/',
  '/events/agent/a-1',
  '/y/doc-1',
  '/signin',
  '/demos',
];

/** Every path a probe is made from, deduplicated, in a stable order. */
export function probePaths(): string[] {
  const paths = new Set<string>(SHELL_PATHS);
  const board = (ws: string): string => `/workspaces/${ws}`;
  for (const ws of [SHARED, OTHER, 'w%2Dshared']) {
    for (const sub of OLD_BOARD_SUBS) paths.add(sub === '' ? board(ws) : `${board(ws)}/${sub}`);
    paths.add(`${board(ws)}/`);
    for (const doc of ['doc-1', 'doc-other', 'doc-orphan', 'doc%2D1', '']) {
      for (const coll of ['docs', 'mockups', 'whiteboards']) {
        for (const verb of OLD_DOC_VERBS) {
          paths.add(`${board(ws)}/${coll}/${doc}${verb === '' ? '' : `/${verb}`}`);
        }
      }
      for (const tail of ['', '/', '/index.html', '/api/save']) {
        paths.add(`${board(ws)}/apps/${doc}${tail}`);
      }
    }
    for (const task of ['t-1', 't-other', 't-orphan', '']) {
      for (const verb of OLD_TASK_VERBS) {
        paths.add(`${board(ws)}/tasks/${task}${verb === '' ? '' : `/${verb}`}`);
      }
    }
    for (const goal of ['g-1', 'g-other', '']) {
      for (const verb of OLD_GOAL_VERBS) {
        paths.add(`${board(ws)}/goals/${goal}${verb === '' ? '' : `/${verb}`}`);
      }
    }
    for (const set of ['rev-1', 'rev-other', SHARED, '']) {
      for (const verb of OLD_ATTACHMENT_VERBS) {
        paths.add(`${board(ws)}/attachments/${set}${verb === '' ? '' : `/${verb}`}`);
      }
    }
    for (const verb of ['', 'role', 'other']) {
      paths.add(`${board(ws)}/members/member-1${verb === '' ? '' : `/${verb}`}`);
      paths.add(`${board(ws)}/members/${verb === '' ? '' : `/${verb}`}`);
    }
  }
  return [...paths].sort();
}

/** One probe's key, as the recorded verdict file holds it. */
export const probeKey = (target: string, method: string, path: string): string =>
  `${target} ${method} ${path}`;
