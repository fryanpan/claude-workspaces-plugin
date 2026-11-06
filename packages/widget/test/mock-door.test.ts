/**
 * Where the host page sends a frame that left its app door. The address comes
 * from inside the frame, so most of these are what a hostile app's script
 * could send. The real walk is `app-frame-path.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { backInDoor } from '../src/mock-door.ts';

const FRAME = 'https://harborlight.frames.test';
const DOOR = '/workspaces/w-harbor/apps/d-berths/';
const SRC = `${FRAME}${DOOR}insights?cw-frame=1&cw-ft=ticket`;
const back = (left: unknown, page = `${DOOR}insights`) => backInDoor(SRC, page, left);

describe('a frame back under its door', () => {
  it('keeps the path, query and fragment, on the frame origin', () => {
    expect(back('/insights?tab=a%20b&cw-frame=1#map')).toBe(
      `${FRAME}${DOOR}insights?tab=a%20b&cw-frame=1#map`,
    );
    expect(back('/?cw-frame=1')).toBe(`${FRAME}${DOOR}?cw-frame=1`);
  });

  it('puts the frame flag back when the address dropped it, and never a ticket', () => {
    expect(back('/insights')).toBe(`${FRAME}${DOOR}insights?cw-frame=1`);
    expect(back('/insights?tab=a')).toBe(`${FRAME}${DOOR}insights?tab=a&cw-frame=1`);
    expect(back('/insights?not-cw-frame=1#x')).toBe(
      `${FRAME}${DOOR}insights?not-cw-frame=1&cw-frame=1#x`,
    );
  });

  it('keeps a pin restore’s thread in the query', () => {
    expect(back('/insights?tab=b&cw-frame=1&cw-goto=t1')).toBe(
      `${FRAME}${DOOR}insights?tab=b&cw-frame=1&cw-goto=t1`,
    );
  });

  it('never leaves the door, whatever the spelling', () => {
    for (const left of [
      '/../d-other/',
      '/../../apps/d-other/secret',
      '/%2e%2e/d-other/',
      '/.%2E/d-other/',
      '/..\\d-other/',
      '/insights/../../d-other/',
    ]) {
      expect(back(left), left).toBeNull();
    }
  });

  it('keeps a protocol-relative or absolute address on this door or refuses it', () => {
    expect(back('//evil.test/x')).toBe(`${FRAME}${DOOR}evil.test/x?cw-frame=1`);
    for (const left of ['https://evil.test/', 'javascript:alert(1)', '', 'insights', 7, null]) {
      expect(back(left), String(left)).toBeNull();
    }
  });

  it('does nothing on a page with no app door: a mock is one page', () => {
    expect(back('/insights', '/workspaces/w-harbor/mockups/d-tides')).toBeNull();
    expect(back('/insights', '/workspaces/w-harbor/apps/d-berths')).toBeNull();
  });
});
