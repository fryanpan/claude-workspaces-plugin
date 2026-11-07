/** What the page's top bar is, read the same way off a doc and a whiteboard. */
export interface PageRead {
  bar: {
    height: number;
    top: number;
    width: number;
    background: string;
    /** The back arrow's path, and the doc-style crumb's title element. */
    back: string | null;
    title: string | null;
    people: boolean;
  } | null;
  /** The board's page rail, on any page that draws one. */
  nav: { rect: number[]; links: string[][] } | null;
}

/** The chat on a page. */
export interface ChatRead {
  button: { x: number; y: number } | null;
  label: string | null;
  placement: string | null;
  pane: boolean;
  /** `lc-sheet` when it fills a narrow screen, `lc-dock` when docked. */
  paneKind: string | null;
  bar: boolean;
  barAt: { x: number; y: number } | null;
  listening: boolean;
  messageIds: string[];
  voiceBubbles: number;
}

export interface PresenceCase {
  /** The server hearing the person arrive, to the lead's chip on their page. */
  arrivalMs: number;
  /** The lead's point, to the chip changing on an open whiteboard. */
  liveMs: number;
}
export type ArrivalCase = PresenceCase | { error: string };

export interface LiveCase {
  link: string | null;
  surface: string | null;
  docId: string | null;
  /** The answer landed in the open chat with no reload. */
  answerShown: boolean;
}

export interface LinkCase {
  start: 'doc' | 'home';
  href: string;
  target: string | null;
  /** The tab's address after the tap, and the one it should be. */
  address: string;
  expected: string;
  /** The canvas came up. */
  ready: boolean;
  /** Listening again, on a listener the server opened for the new page. */
  listening: boolean;
  before: ChatRead;
  after: ChatRead;
  /** The chat's messages, opened from the bar where the page left it there. */
  conversation: ChatRead;
  /** Something of the chat lies over the middle of the canvas. */
  canvasCovered: boolean;
}

export interface CanvasRead {
  stage: { left: number; right: number; width: number; height: number };
  canvasWidth: number;
  /** The canvas fills the stage, and the docked chat covers none of it. */
  canvasFits: boolean;
  /** The agent button lies on one of Excalidraw's own controls. */
  buttonOnControl: string | null;
  /** The bar a voice-first tap brings out lies on one of them. */
  barOnControl: string | null;
  /** Excalidraw has picked its phone layout. */
  phoneLayout: boolean;
  centreCovered: boolean;
  scroll: [number, number];
}

export interface CanvasCase {
  toolAfterKey: string | null;
  drew: number;
  closed: CanvasRead;
  chatOpen: boolean;
  composer: string;
  toolBeforeTyping: string | null;
  toolAfterTyping: string | null;
  elementsWhileTyping: number;
  open: CanvasRead;
  /** With a voice-first tap, which brings out the bar rather than the panel. */
  voiceBar: { shown: boolean; canvas: CanvasRead };
  /** At 1180, the chat dragged as wide as it goes. */
  wideDock: CanvasRead | null;
  narrowDock: CanvasRead | null;
}

/** Leaving through the board's nav with the chat's sheet open. */
export interface NavLeave {
  sheetBefore: boolean;
  landed: string;
  /** The chat's pane is open again on the page the reader went to. */
  paneAfter: boolean;
}

/** An agent drawing on a whiteboard someone has open. */
export interface LiveDrawCase {
  /** Elements on the open canvas before, after a draw, and after a replace. */
  before: number;
  afterDraw: number;
  afterReplace: number;
  /** The drawn shape's ink on the canvas before and after the draw. */
  inkBefore: number;
  inkAfter: number;
  /** The draw's response, to the canvas showing it. */
  drawMs: number;
  replaceMs: number;
  /** Still the page that was open when the agent drew. */
  noReload: boolean;
}

export interface SizeRun {
  width: number;
  mockPage: PageRead;
  liveDraw: LiveDrawCase;
  /** Phone only: the sheet stands over the page below 1100px. */
  navLeave: { whiteboard: NavLeave; mock: NavLeave } | null;
  docPage: PageRead;
  whiteboardPage: PageRead;
  docChat: ChatRead;
  whiteboardChat: ChatRead;
  presence: ArrivalCase;
  live: LiveCase;
  links: LinkCase[];
  canvas: CanvasCase;
}

export interface WhiteboardChatRun {
  workspaceId: string;
  whiteboard: string;
  sizes: SizeRun[];
}
