import { describe, expect, it } from 'bun:test';
import { MemoryCollabStorage, createRoomHost } from '@claude-workspaces/core/collab';
import { CollabRooms } from '../src/collab-rooms.ts';

describe('CollabRooms', () => {
  it('rechecks every registered host, and none after unregister', () => {
    const roles = new Map<string, 'edit' | 'view' | null>([['alice', 'edit']]);
    const host = createRoomHost({
      storage: new MemoryCollabStorage(),
      role: (p) => roles.get(p.id) ?? null,
    });
    const rooms = new CollabRooms();
    const unregister = rooms.register(host);
    let revoked = 0;
    const opened = host.connect({
      roomId: 'riverbend',
      principal: { id: 'alice' },
      send: () => {},
      onRevoked: () => {
        revoked++;
      },
    });
    if (!opened.ok) throw new Error(opened.error);

    roles.set('alice', 'view');
    rooms.recheck();
    expect(opened.connection.role).toBe('view');
    expect(revoked).toBe(0);

    unregister();
    roles.set('alice', null);
    rooms.recheck();
    expect(revoked).toBe(0);

    rooms.register(host);
    rooms.recheck();
    expect(revoked).toBe(1);
  });
});
