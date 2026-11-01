import { useEffect, useState } from "react";
import type { LiveFeed } from "./daemon-events.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/**
 * Data the daemon announces by a revision on `/ws` (`board.changed`, `mcp.calls.changed`): `load` runs again whenever
 * the revision grows, and as a fallback every `livePollMs` while the events are live, every `pollMs` without them.
 */
export function useRevisionRemote<T>(
  load: () => Promise<T>,
  live: LiveFeed<{ revision: number }> | undefined,
  pace: { livePollMs: number; pollMs: number },
): RemoteHandle<T> {
  const [revision, setRevision] = useState<number>();
  useEffect(() => live?.subscribe((topic) => setRevision(topic.revision)), [live]);
  return useRemote(load, { refreshKey: String(revision ?? ""), pollMs: () => (live?.isLive() ? pace.livePollMs : pace.pollMs) });
}
