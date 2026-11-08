import { readSessions, type ViewerRead } from "./viewer-client.ts";

/**
 * Looks at the daemon again and again: every 2 s while the VS Code window has the focus, every 10 s while it does not,
 * so a background window costs the daemon one small request in ten seconds. One look at a time; `refresh` starts the
 * next at once. The loop asks, the daemon pushes nothing, so the extension holds no connection open and needs no events
 * socket, which the viewer token does not open.
 */

export const FOCUSED_INTERVAL_MS = 2000;
export const BACKGROUND_INTERVAL_MS = 10_000;

export interface SessionWatch {
  refresh: () => void;
  dispose: () => void;
}

export function watchSessions(o: {
  folder: () => string;
  focused: () => boolean;
  onRead: (read: ViewerRead) => void;
  read?: typeof readSessions;
}): SessionWatch {
  const read = o.read ?? readSessions;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let disposed = false;

  async function look(): Promise<void> {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      const result = await read(o.folder()).catch((err: unknown): ViewerRead => ({ kind: "unavailable", reason: String(err) }));
      if (!disposed) o.onRead(result);
    } catch (err) {
      // A failure of VS Code's API while it shows the result must not end the loop as an unhandled rejection.
      console.error(`[trackwall] cannot show the sessions: ${String(err)}`);
    } finally {
      running = false;
      next();
    }
  }

  /** The next look: at once when a refresh came during this one, otherwise after the interval. */
  function next(): void {
    if (disposed) return;
    if (again) {
      again = false;
      void look();
      return;
    }
    timer = setTimeout(() => void look(), o.focused() ? FOCUSED_INTERVAL_MS : BACKGROUND_INTERVAL_MS);
  }

  void look();
  return {
    refresh: () => void look(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
