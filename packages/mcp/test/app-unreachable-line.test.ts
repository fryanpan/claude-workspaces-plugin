/** The wording of the app-down wake (`app-unreachable-line.ts`). */
import { describe, expect, it } from 'vitest';
import { appUnreachableLine } from '../src/app-unreachable-line.ts';

const FRAME = {
  docId: 'd-harbor',
  title: 'Harborlight site',
  origin: 'http://127.0.0.1:4321',
  prefix: '/workspaces/w-1/apps/d-harbor/',
  reason: 'Unable to connect',
  addressedAs: 'attacher' as const,
};

describe('appUnreachableLine', () => {
  it('names the app, the origin to listen on, and what readers see', () => {
    const line = appUnreachableLine(FRAME);
    expect(line).toContain('"Harborlight site" (d-harbor)');
    expect(line).toContain('http://127.0.0.1:4321 (Unable to connect)');
    expect(line).toContain('/workspaces/w-1/apps/d-harbor/');
    expect(line).toContain('Start its dev server');
    expect(line).not.toContain('board lead');
  });

  it('says so when the lead is told because nobody attached it on record', () => {
    expect(appUnreachableLine({ ...FRAME, addressedAs: 'lead' })).toContain(
      'You are told as the board lead',
    );
  });
});
