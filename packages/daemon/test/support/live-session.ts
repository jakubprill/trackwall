import type { LiveSession } from "../../src/modules/agents/live-session.ts";

/** Resolves once the session's screen emulator has processed the output written so far. */
export function screenProcessed(session: LiveSession): Promise<void> {
  return new Promise((resolve) => {
    const window = session.attach(
      () => {},
      () => {
        window.detach();
        resolve();
      },
      () => {},
    );
  });
}
