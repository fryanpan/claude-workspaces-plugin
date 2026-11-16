import { splice } from '../client/text-binding.ts';
/**
 * Two server actions an app's tool dispatch calls through
 * `room.action(roomId, agentPrincipal(sessionId), name, body)`:
 *
 *   editDoc  change a doc's text, as a whole or one passage
 *   setTile  write one tile of a dashboard: a JSON value in a shared map
 *
 * Both are edits, so the core refuses them to a `view` or `comment` role.
 * Neither throws on a bad body: each returns an `EditResult` the tool hands
 * back to the agent, because a thrown error would end the app's action call
 * rather than tell the agent what to fix. Each writes in one transaction
 * whose origin is the principal that ran it.
 */
import type { ActionHandler } from '../collab/index.ts';

export type EditResult =
  | { ok: true }
  | { ok: false; error: 'bad-body' | 'no-match' | 'ambiguous' | 'too-large'; message: string };

const fail = (error: Exclude<EditResult, { ok: true }>['error'], message: string): EditResult => ({
  ok: false,
  error,
  message,
});

/**
 * Edit the `Y.Text` named `field` (default `body`). The body is either
 * `{ text }`, the whole new text, or `{ find, replace }`, where `find` must
 * occur exactly once. A whole-text change is applied as the one splice
 * between old and new, so a reader's cursor outside the changed passage
 * stays where it was.
 */
export function editDocAction(opts: { field?: string } = {}): ActionHandler {
  const field = opts.field ?? 'body';
  return ({ doc, principal }, body): EditResult => {
    const text = doc.getText(field);
    const before = text.toString();
    let after: string;
    if (typeof body.text === 'string') {
      after = body.text;
    } else if (typeof body.find === 'string' && typeof body.replace === 'string') {
      if (body.find === '') return fail('bad-body', '`find` is empty.');
      const at = before.indexOf(body.find);
      if (at < 0) return fail('no-match', 'The text does not contain `find`.');
      if (before.indexOf(body.find, at + 1) >= 0) {
        return fail('ambiguous', '`find` occurs more than once; quote more of the passage.');
      }
      after = before.slice(0, at) + body.replace + before.slice(at + body.find.length);
    } else {
      return fail('bad-body', 'Send `{ text }` or `{ find, replace }`, each a string.');
    }
    const s = splice(before, after);
    doc.transact(() => {
      if (s.remove > 0) text.delete(s.index, s.remove);
      if (s.insert) text.insert(s.index, s.insert);
    }, principal);
    return { ok: true };
  };
}

const TILE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Write one tile of the root `Y.Map` named `map` (default `tiles`). The
 * body is `{ tile, value }`: `value` is any JSON, stored as a plain value
 * (a page reads it with `watchMap`), and `null` removes the tile. A value
 * whose JSON is over `maxBytes` characters (default 64 KiB) is refused.
 */
export function setTileAction(opts: { map?: string; maxBytes?: number } = {}): ActionHandler {
  const name = opts.map ?? 'tiles';
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return ({ doc, principal }, body): EditResult => {
    const { tile, value } = body;
    if (typeof tile !== 'string' || !TILE.test(tile)) {
      return fail('bad-body', '`tile` is 1-64 letters, digits, `_`, `.` or `-`.');
    }
    if (value === undefined) return fail('bad-body', 'Send `value`; `null` removes the tile.');
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return fail('bad-body', '`value` is not JSON.');
    }
    if (json.length > maxBytes) {
      return fail('too-large', `\`value\` is ${json.length} characters; the limit is ${maxBytes}.`);
    }
    const tiles = doc.getMap(name);
    doc.transact(() => {
      if (value === null) tiles.delete(tile);
      else tiles.set(tile, JSON.parse(json));
    }, principal);
    return { ok: true };
  };
}
