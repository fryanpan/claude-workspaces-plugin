/**
 * What `tab-title-browser-driver.ts` opens and prints, and what each page's
 * tab should read. Shared by the driver and `tab-title-browser.test.ts`
 * without the test importing the driver, which runs on import.
 */
export const PAGE_KINDS = [
  'board',
  'home',
  'task',
  'goal',
  'doc',
  'mock',
  'diff',
  'folder',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** What each page's tab should read: the workspace's name, then the page's own. */
export const EXPECTED: Record<PageKind, string> = {
  board: 'Harborlight · Workspaces',
  home: 'Harborlight · Home · Workspaces',
  task: 'Harborlight · Paint the Saltmarsh slipway · Workspaces',
  goal: 'Harborlight · Open the Riverbend ferry · Workspaces',
  doc: 'Harborlight · Riverbend tides · Workspaces',
  mock: 'Harborlight · Moorings · Workspaces',
  diff: 'Harborlight · ferry.ts · Workspaces',
  folder: 'Harborlight · notes.md · Workspaces',
};

export interface TitleRead {
  width: number;
  page: PageKind;
  title: string;
}

/** A page held open while the workspace and its own thing are renamed. */
export interface LiveRename {
  page: 'doc' | 'mock' | 'task';
  before: string;
  /** After the workspace was renamed to `workspace`. */
  afterWorkspace: string;
  workspace: string;
  /** After the page's own thing was renamed to `name`. */
  afterName: string;
  name: string;
  /** The page never reloaded: a marker set before the renames survived. */
  sameDocument: boolean;
}

export interface TabTitleRun {
  workspace: string;
  reads: TitleRead[];
  live: LiveRename[];
}
