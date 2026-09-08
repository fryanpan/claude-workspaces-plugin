import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectMockupLive, mockupLiveEmbed, parseVersionParam } from '../src/mockup-live.ts';
import {
  MAX_MOCKUP_VERSIONS,
  deleteMockupVersions,
  listMockupVersions,
  mockupVersionPath,
  readMockupVersion,
  recordMockupVersion,
} from '../src/mockup-versions.ts';

describe('mockup rounds', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-versions-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('numbers each distinct capture and reads every one back', () => {
    expect(recordMockupVersion(dir, 'd1', '<p>one</p>').version).toBe(1);
    expect(recordMockupVersion(dir, 'd1', '<p>two</p>').version).toBe(2);
    expect(readMockupVersion(dir, 'd1', 1)).toBe('<p>one</p>');
    expect(readMockupVersion(dir, 'd1', 2)).toBe('<p>two</p>');
    expect(listMockupVersions(dir, 'd1').map((r) => r.v)).toEqual([1, 2]);
  });

  it('records nothing when the bytes have not changed', () => {
    recordMockupVersion(dir, 'd1', '<p>same</p>');
    const again = recordMockupVersion(dir, 'd1', '<p>same</p>');
    expect(again.recorded).toBe(false);
    expect(listMockupVersions(dir, 'd1')).toHaveLength(1);
  });

  it('records a revert as its own round rather than folding it onto the old one', () => {
    // A mock that goes back to how it looked two rounds ago has still changed
    // twice. Collapsing them would make the history lie about when a reviewer
    // saw what.
    recordMockupVersion(dir, 'd1', '<p>a</p>');
    recordMockupVersion(dir, 'd1', '<p>b</p>');
    expect(recordMockupVersion(dir, 'd1', '<p>a</p>').version).toBe(3);
    expect(listMockupVersions(dir, 'd1').map((r) => r.v)).toEqual([1, 2, 3]);
  });

  it('drops the oldest rounds past the cap and never reuses their numbers', () => {
    for (let i = 0; i <= MAX_MOCKUP_VERSIONS; i++) recordMockupVersion(dir, 'd1', `<p>${i}</p>`);
    const rounds = listMockupVersions(dir, 'd1');
    expect(rounds).toHaveLength(MAX_MOCKUP_VERSIONS);
    expect(rounds[0]?.v).toBe(2);
    expect(readMockupVersion(dir, 'd1', 1)).toBeNull();
    expect(existsSync(mockupVersionPath(dir, 'd1', 1))).toBe(false);
    // The next round keeps counting up, so `?v=` on a stale link cannot come
    // back as somebody else's round.
    expect(recordMockupVersion(dir, 'd1', '<p>next</p>').version).toBe(MAX_MOCKUP_VERSIONS + 2);
  });

  it('survives a corrupt index without minting a number that is already taken', () => {
    recordMockupVersion(dir, 'd1', '<p>one</p>');
    recordMockupVersion(dir, 'd1', '<p>two</p>');
    writeFileSync(join(dir, 'd1.mock.versions.json'), 'not json');
    const next = recordMockupVersion(dir, 'd1', '<p>three</p>');
    expect(next.version).toBe(3);
    // Round two's bytes are still on disk and still addressable.
    expect(readMockupVersion(dir, 'd1', 2)).toBe('<p>two</p>');
  });

  it('a purge takes the rounds and the index with it', () => {
    recordMockupVersion(dir, 'd1', '<p>one</p>');
    recordMockupVersion(dir, 'd1', '<p>two</p>');
    deleteMockupVersions(dir, 'd1');
    expect(listMockupVersions(dir, 'd1')).toEqual([]);
    expect(existsSync(mockupVersionPath(dir, 'd1', 2))).toBe(false);
    expect(existsSync(join(dir, 'd1.mock.versions.json'))).toBe(false);
  });
});

describe('the mockup live embed', () => {
  it('reads a round off ?v= and refuses anything that is not one', () => {
    expect(parseVersionParam(null)).toBeNull();
    expect(parseVersionParam('3')).toBe(3);
    expect(parseVersionParam('0')).toBe('bad');
    expect(parseVersionParam('-1')).toBe('bad');
    expect(parseVersionParam('1.5')).toBe('bad');
    expect(parseVersionParam('abc')).toBe('bad');
    expect(parseVersionParam('')).toBe('bad');
  });

  it('carries the board, the doc and the rounds, with the quotes escaped', () => {
    const embed = mockupLiveEmbed({
      docId: 'd-1"onload="x',
      workspaceId: 'w-1',
      version: 2,
      versions: [
        { v: 1, at: 1, bytes: 10 },
        { v: 2, at: 2, bytes: 12 },
      ],
    });
    expect(embed).toContain('data-versions="1,2"');
    expect(embed).toContain('data-version="2"');
    expect(embed).toContain('data-workspace-id="w-1"');
    // An id cannot break out of its attribute and open one of its own.
    expect(embed).toContain('data-doc-id="d-1&quot;onload=&quot;x"');
    expect(embed).not.toContain('onload="x"');
  });

  it('goes in before </body>, appends without one, and never doubles up', () => {
    const info = {
      docId: 'd',
      workspaceId: 'w',
      version: 1,
      versions: [{ v: 1, at: 1, bytes: 1 }],
    };
    const page = injectMockupLive('<html><body><p>hi</p></body></html>', info);
    expect(page.indexOf('mockup-live.js')).toBeLessThan(page.indexOf('</body>'));
    expect(injectMockupLive('<p>fragment</p>', info)).toContain('mockup-live.js');
    expect(injectMockupLive(page, info)).toBe(page);
  });
});
