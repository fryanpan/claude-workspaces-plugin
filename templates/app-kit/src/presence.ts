/**
 * Who else has a doc open: the server half of the doc page's presence strip.
 *
 * The collab core's presence hub decides everything (`createPresenceHub`):
 * identity and doc come from the socket, never from what the page sends; a
 * person shows once however many tabs they have; the role function is asked
 * again on every update and view, so somebody whose role is gone is shown to
 * nobody and sees nobody. This file is only the socket's half: what a page
 * sends (`{"spot":{}}`, "I am on this doc") and what it is sent back
 * (`{"here":[{"id","name"}],"role":"edit"}`, everyone else on it and the
 * reader's own role), as JSON text frames on
 * `/docs/<id>/presence`.
 *
 * Each doc is a room and its page is the only page with presence, so a page
 * shows who is on the same doc. The app has no boards; nothing here asks for
 * one.
 */
import {
  type PresenceConnection,
  type Principal,
  type RoleFn,
  createPresenceHub,
} from '@claude-workspaces/app-kit/collab';

type Spot = { page: 'doc' };

/** What `app.ts` keeps on a presence socket. */
export interface PresenceSocket {
  docId: string;
  who: Principal;
  send(text: string): void;
  close(code: number, reason: string): void;
  conn?: PresenceConnection<Spot>;
}

export interface DocPresence {
  open(ws: PresenceSocket): void;
  message(ws: PresenceSocket, text: string): void;
  close(ws: PresenceSocket): void;
  /** After a role change on `docId`: close the sockets whose role is gone,
   *  and send everyone else what they may see now. */
  recheck(docId: string): void;
}

export function createDocPresence(role: RoleFn): DocPresence {
  const hub = createPresenceHub<Spot>({
    role,
    parseSpot: (raw) =>
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { page: 'doc' } : null,
    pageOf: (spot) => spot.page,
    hasPresence: () => true,
    appWide: false,
  });
  const open = new Map<string, Set<PresenceSocket>>();

  const push = (ws: PresenceSocket): void => {
    if (!ws.conn) return;
    const here = ws.conn.view().here.map((p) => ({ id: p.id, name: p.name }));
    // The reader's own role rides along, so a role change reaches their page
    // on the push `recheck` already makes, without a reload.
    try {
      ws.send(JSON.stringify({ here, role: role(ws.who, ws.docId) }));
    } catch {
      // A socket that died mid-send: its close is on its way.
    }
  };

  return {
    open(ws) {
      const res = hub.join({ roomId: ws.docId, principal: ws.who, onChange: () => push(ws) });
      if (!res.ok) {
        ws.close(1008, res.error);
        return;
      }
      ws.conn = res.connection;
      let set = open.get(ws.docId);
      if (!set) open.set(ws.docId, (set = new Set()));
      set.add(ws);
    },
    message(ws, text) {
      if (!ws.conn || text.length > 1024) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const spot = (msg as { spot?: unknown } | null)?.spot;
      const result = ws.conn.update(spot);
      if (result === 'applied') push(ws);
      else if (result === 'revoked') ws.close(1008, 'revoked');
    },
    close(ws) {
      ws.conn?.close();
      const set = open.get(ws.docId);
      set?.delete(ws);
      if (set?.size === 0) open.delete(ws.docId);
    },
    recheck(docId) {
      for (const ws of [...(open.get(docId) ?? [])]) {
        if (role(ws.who, docId) === null) ws.close(1008, 'revoked');
        else push(ws);
      }
    },
  };
}
