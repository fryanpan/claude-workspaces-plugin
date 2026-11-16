/**
 * Forget what this tab kept, for the next load to start fresh.
 *
 * The lead chat keeps "voice on" in session storage, and rewrites it on
 * every change of voice state. A page still starting the voice it carried
 * over can rewrite it after a bare `sessionStorage.clear()` and before the
 * navigation that follows, so the next page carries voice on: its bar comes
 * out, and the driver's tap on the agent button then means "close and stop
 * listening". lead-chat-written-browser failed that way four times on
 * 16 Nov (`listening` false, bar not out, the press and click both seen).
 * So the page that is about to be left also loses the ability to write.
 */
export const FORGET_TAB = `(() => {
  sessionStorage.clear();
  Storage.prototype.setItem = function () {};
})()`;
