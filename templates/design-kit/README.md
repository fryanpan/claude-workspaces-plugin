# Design-kit trial (M3)

A test area for one question: can [Web Awesome](https://webawesome.com/docs/)
3.14.0 be the kit every site shares, with one theme file per site? Nothing
here is part of the product. No live surface imports it.

It is a root workspace (`templates/*`), so the root `bun install` installs its
pinned dependencies and the root `bun.lock` records them.

```bash
bun install        # at the repo root
cd templates/design-kit
bun run test       # 12 cases; 8 in a headless Chrome (sets CW_BROWSER_TESTS=1)
bun run measure    # gzip-9 sizes and time to interactive
bun run serve      # http://127.0.0.1:<port>/t/workspaces/review-list.html
bun run typecheck
```

## Layout

- `themes/<site>.css` is a site's theme file. It is the only file a site
  writes. See `themes/workspaces.css` for the format.
- `pages/review-list.html` (plain HTML) and `pages/tasks.html` (Preact,
  `src/tasks.tsx`) are the two test pages. Neither names a theme.
- `src/kit.ts` imports the six components the pages use. `src/kit.css` holds
  the kit's native-element styles, layout utilities and the pages' layout.
- `scripts/serve.ts` serves a page under `/t/<theme>/`. The page's relative
  `theme.css` link then resolves to that theme's file, so the URL picks the
  theme and the markup never does.
- `scripts/drive.ts` drives a headless Chrome through the repo's own launcher
  (`scripts/headless-chrome.ts`): a throwaway profile, and no window.

## Compact

`[data-density="compact"]` on `<html>` turns on the theme's compact block. It
is a per-device preference, read from `localStorage['kit-density']` (or
`?density=compact` for a headless run). A theme without the block ignores it.
