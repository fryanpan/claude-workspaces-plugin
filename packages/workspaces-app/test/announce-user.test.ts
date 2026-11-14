import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { announceUser } from '../src/presence/announce-user.ts';

describe('the user a page announces in its presence', () => {
  it("carries the browser's stable id, so the server can name a guest the same on every socket", () => {
    const awareness = new Awareness(new Y.Doc());
    announceUser(awareness, {
      id: 'anon-riverbend1',
      name: 'Alice',
      kind: 'known',
      color: '#336699',
    });
    expect(awareness.getLocalState()?.user).toEqual({
      id: 'anon-riverbend1',
      name: 'Alice',
      color: '#336699',
    });
    awareness.destroy();
  });
});
