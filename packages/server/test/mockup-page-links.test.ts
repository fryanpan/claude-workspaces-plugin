import { describe, expect, it } from 'bun:test';
import {
  NAMED_LINK_LIMIT,
  mockupLinkWarning,
  rootRelativePageLinks,
} from '../src/mockup-page-links.ts';

describe('rootRelativePageLinks', () => {
  it('takes <a href> and <form action> that start with a single slash', () => {
    const html = `<A HREF="/a/">x</A><a class="n" href='/b'>y</a><a href=/c>z</a>
      <form method="post" action="/send"></form>`;
    expect(rootRelativePageLinks(html)).toEqual(['/a/', '/b', '/c', '/send']);
  });

  it('leaves out protocol-relative, absolute, relative and fragment links', () => {
    const html = `<a href="//cdn.test/x"></a><a href="https://h.test/"></a>
      <a href="page.html"></a><a href="#top"></a><a href="../up"></a>`;
    expect(rootRelativePageLinks(html)).toEqual([]);
  });

  it('ignores asset URLs and attributes other than the navigation one', () => {
    const html = `<link href="/s.css"><script src="/s.js"></script><img src="/i.png">
      <area href="/map"><abbr title="/x"></abbr><a data-href="/no" href="ok.html"></a>
      <form data-action="/no"></form>`;
    expect(rootRelativePageLinks(html)).toEqual([]);
  });

  it('dedupes in page order', () => {
    expect(rootRelativePageLinks('<a href="/b"></a><a href="/a"></a><a href="/b"></a>')).toEqual([
      '/b',
      '/a',
    ]);
  });
});

describe('mockupLinkWarning', () => {
  it('is undefined with no links', () => {
    expect(mockupLinkWarning([])).toBeUndefined();
  });

  it('names at most the limit and counts the rest', () => {
    const links = Array.from({ length: NAMED_LINK_LIMIT + 2 }, (_, i) => `/p${i}`);
    const w = mockupLinkWarning(links);
    expect(w?.links).toEqual(links.slice(0, NAMED_LINK_LIMIT));
    expect(w?.count).toBe(links.length);
    expect(w?.message).toContain('and 2 more');
    expect(w?.message).not.toContain(`/p${NAMED_LINK_LIMIT}`);
    expect(w?.appUrl).toBeUndefined();
  });

  it("names the board's app address when there is one", () => {
    const w = mockupLinkWarning(['/x'], {
      docId: 'site',
      reviewUrl: 'http://h.test/workspaces/w-1/apps/site/',
    });
    expect(w?.appUrl).toBe('http://h.test/workspaces/w-1/apps/site/');
    expect(w?.message).toContain('share http://h.test/workspaces/w-1/apps/site/ instead');
  });
});
