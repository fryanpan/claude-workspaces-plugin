/**
 * A resolve leaves an open app page in the frame-host frame. The cases, and why
 * each frame is its own file, are `app-resolve-cases.ts`.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { describeResolve } from './app-resolve-cases.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

describeResolve(CHROME, 'frame-host');
