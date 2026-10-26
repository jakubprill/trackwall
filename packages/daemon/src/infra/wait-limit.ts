/**
 * A wait with a time limit that the caller can also give up (an MCP client that cancelled its call): the value of
 * `promise`, or `"gave_up"` when the limit or `signal` came first. The promise itself is not cancelled; only the
 * wait ends.
 */
export async function waitLimited<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | "gave_up"> {
  const limit = AbortSignal.timeout(timeoutMs);
  const giveUp = signal ? AbortSignal.any([signal, limit]) : limit;
  let stopWaiting = () => {};
  const gaveUp = new Promise<"gave_up">((resolve) => {
    stopWaiting = () => resolve("gave_up");
  });
  giveUp.addEventListener("abort", stopWaiting, { once: true });
  if (giveUp.aborted) stopWaiting();
  try {
    return await Promise.race([promise, gaveUp]);
  } finally {
    giveUp.removeEventListener("abort", stopWaiting);
  }
}
