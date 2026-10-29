/**
 * A log line whenever the daemon's event loop stood still (ADR-117). Everything the daemon serves waits behind such a
 * stall: a session terminal that opens gets its screen late and stays black meanwhile. Where an antivirus scans every
 * process start, the starts are a suspect (§4.5, ADR-79), and the line shows whether and when the loop stood.
 */

/** How often the watch checks the loop; a stall shows as a tick that came this much later than due. */
const CHECK_MS = 250;
/** A stall shorter than this is not worth a line: the user does not notice it, and the log would fill with them. */
const STALL_MS = 500;

/** The log line of a check that came `lateMs` after it was due, or `undefined` for one that came in time. */
export function stallNote(lateMs: number): string | undefined {
  if (lateMs < STALL_MS) return undefined;
  return `the event loop stood still for at least ${Math.round(lateMs)} ms`;
}

/** Watches the event loop until the returned function stops it; the watch does not keep the process alive. */
export function watchEventLoopStalls(log: (msg: string) => void): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const note = stallNote(now - last - CHECK_MS);
    last = now;
    if (note) log(note);
  }, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
