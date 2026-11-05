import { describe, expect, it } from 'vitest';
import { boardStreamUrl, openBoardStream } from '../src/board-stream.ts';

/**
 * One board stream per page: the lead chat and the tab title both listen to
 * it, and each extra stream would hold one more of the browser's few
 * connections per host for as long as the page is open.
 */
class FakeSource extends EventTarget {
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function opener() {
  const opened: FakeSource[] = [];
  const open = (url: string) => {
    const s = new FakeSource(url);
    opened.push(s);
    return s as unknown as EventSource;
  };
  return { opened, open };
}

describe('openBoardStream', () => {
  it('opens one stream for every reader on the page', () => {
    const { opened, open } = opener();
    const a = openBoardStream('w-harbor one', open);
    const b = openBoardStream('w-harbor one', open);
    expect(opened.map((s) => s.url)).toEqual([boardStreamUrl('w-harbor one')]);
    expect(boardStreamUrl('w-harbor one')).toBe('/workspaces/w-harbor%20one/events:stream');
    const heard: string[] = [];
    a.addEventListener('workspace.renamed', () => heard.push('a'));
    b.addEventListener('workspace.renamed', () => heard.push('b'));
    opened[0]?.dispatchEvent(new MessageEvent('workspace.renamed', { data: '{}' }));
    expect(heard).toEqual(['a', 'b']);
    a.close();
    b.close();
  });

  it('closing one reader takes off only its listeners, and the last closes the stream', () => {
    const { opened, open } = opener();
    const a = openBoardStream('w-riverbend', open);
    const b = openBoardStream('w-riverbend', open);
    const heard: string[] = [];
    a.addEventListener('library.changed', () => heard.push('a'));
    b.addEventListener('library.changed', () => heard.push('b'));
    a.close();
    expect(a.readyState).toBe(2);
    expect(opened[0]?.closed).toBe(false);
    opened[0]?.dispatchEvent(new MessageEvent('library.changed'));
    expect(heard).toEqual(['b']);
    b.close();
    expect(opened[0]?.closed).toBe(true);
    // A reader after the last close gets a new stream.
    openBoardStream('w-riverbend', open).close();
    expect(opened).toHaveLength(2);
  });

  it('does not hand out a stream the browser gave up on', () => {
    const { opened, open } = opener();
    const a = openBoardStream('w-saltmarsh', open);
    if (opened[0]) opened[0].readyState = 2;
    const b = openBoardStream('w-saltmarsh', open);
    expect(opened).toHaveLength(2);
    a.close();
    b.close();
    expect(opened[1]?.closed).toBe(true);
  });
});
