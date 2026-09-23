/**
 * The entry of `edit.js` — edit mode, fetched by the pencil on its first tap
 * or at load when the page has edits waiting (`edit-button.ts`). It hands its
 * one function to the page on `window.cwEdit`, as `voice.js` does.
 */
import { mountEditMode } from './edit-mode.ts';

window.cwEdit = { mountEditMode };
