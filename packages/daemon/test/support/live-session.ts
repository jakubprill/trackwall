import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A Copilot CLI home with no conversations, for sessions whose usage a test does not look at (ADR-190). */
export const NO_COPILOT_HOME = join(tmpdir(), "trackwall-test-no-copilot-home");
