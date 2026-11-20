/**
 * Who may do what to each doc: the app's role table, one row per doc and
 * person, in its own SQLite file.
 *
 * The rules:
 *   - The first signed-in person to open a doc becomes its `owner`.
 *   - Only an owner changes a role (`POST /docs/<id>/roles` in `app.ts`),
 *     and never their own, so a doc always keeps an owner.
 *   - Anybody with no row gets `defaultRole`: `edit` unless the app passes
 *     another, so a kit app behaves as it did before roles existed. `null`
 *     makes every doc invite-only.
 *
 * `role` is the `RoleFn` the collab core asks on every connect, every
 * presence update and view, and again on `recheckRoles`, which `app.ts` calls
 * after every change here: an open socket of somebody made `view` stops
 * writing at once, and one whose role is removed is closed. The refusal is
 * the core's (`room-host.ts` drops a reader's update unread), so it holds
 * however the page behaves.
 *
 * The four words are the board's (`share/board-access.ts`'s `AccessRole`,
 * the M9 roles): `owner`, `edit`, `comment`, `view`. When an app is reached
 * through a board, its role function becomes a read of that board's
 * membership row, `(who, docId) => accessRoleOf(seat, access)` for the board
 * holding the doc, and this table stays the answer for an app that has no
 * board. The core needs nothing more than the function either way, so moving
 * an app onto the board's table changes this file and nothing that calls it.
 */
import { Database } from 'bun:sqlite';
import type { CollabRole, Principal, RoleFn } from '@claude-workspaces/app-kit/collab';

export const ROLES: readonly CollabRole[] = ['owner', 'edit', 'comment', 'view'];

export const isRole = (v: unknown): v is CollabRole =>
  typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export interface DocRoles {
  /** The core's role function over this table. */
  role: RoleFn;
  /** Make `who` the doc's owner if it has none yet; returns `who`'s role. */
  claim(docId: string, who: Principal): CollabRole | null;
  /** Set a person's role on a doc. */
  set(docId: string, personId: string, role: CollabRole): void;
  close(): void;
}

export function openDocRoles(path: string, defaultRole: CollabRole | null = 'edit'): DocRoles {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS doc_role (
    doc_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'edit', 'comment', 'view')),
    PRIMARY KEY (doc_id, person_id)
  )`);
  const read = db.query<{ role: string }, [string, string]>(
    'SELECT role FROM doc_role WHERE doc_id = ? AND person_id = ?',
  );
  const claimed = db.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM doc_role WHERE doc_id = ?',
  );
  const upsert = db.query<unknown, [string, string, string]>(
    `INSERT INTO doc_role (doc_id, person_id, role) VALUES (?, ?, ?)
     ON CONFLICT (doc_id, person_id) DO UPDATE SET role = excluded.role`,
  );

  const role: RoleFn = (who, docId) => {
    const row = read.get(docId, who.id);
    return row && isRole(row.role) ? row.role : defaultRole;
  };
  const claimTx = db.transaction((docId: string, personId: string) => {
    if ((claimed.get(docId)?.n ?? 0) === 0) upsert.run(docId, personId, 'owner');
  });

  return {
    role,
    claim(docId, who) {
      claimTx(docId, who.id);
      return role(who, docId);
    },
    set(docId, personId, next) {
      upsert.run(docId, personId, next);
    },
    close: () => db.close(),
  };
}
