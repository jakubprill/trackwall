/**
 * A wait with a time limit that the caller can also give up (an MCP client that cancelled its call): the value of
 * `promise`, or `"gave_up"` when the limit or `signal` came first. The promise itself is not cancelled; only the
 * wait ends. Shared by the waits of agents for a mise task (ADR-41) and a verification (ADR-64).
 */
export async function waitLimited<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T | "gave_up"> {
  const giveUp = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
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
