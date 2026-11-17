/**
 * The core's room hosts this server runs (`@claude-workspaces/core/collab`),
 * and the one call that asks each of them to recheck its connections' roles.
 *
 * Revocation has two paths while both kinds of socket exist (D1 step 8).
 * The server's own doc and board sockets are found by the membership key
 * stamped on them and closed by the existing sweeps. A connection held by a
 * core room host carries no such key: its host asks its role function again
 * (`recheckRoles`), drops a connection whose role is gone and calls the
 * app's `onRevoked`. Every place that ends or changes a grant calls `recheck`
 * here beside its sweep, so both kinds close on the same revoke.
 */
import type { RoomHost } from '@claude-workspaces/core/collab';

export class CollabRooms {
  private readonly hosts = new Set<RoomHost>();

  /** Run `host`'s rechecks on every revoke. Returns the unregister. */
  register(host: RoomHost): () => void {
    this.hosts.add(host);
    return () => {
      this.hosts.delete(host);
    };
  }

  /** Ask every registered host to recheck every open connection's role. */
  recheck(): void {
    for (const host of this.hosts) host.recheckRoles();
  }
}
