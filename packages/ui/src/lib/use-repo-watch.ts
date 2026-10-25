import type { RepoWatchState } from "@trackwall/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveFeed } from "./daemon-events.ts";
import { RepoChangeCounter, type RepoPollPace } from "./repo-watch.ts";

/** Repo changes from the events WebSocket (ADR-63) for the views that show data depending on commits. */
export interface RepoWatchHandle {
  /**
   * The `useRemote` options of data with this pace: fetched again after every reported change (`refreshKey`), and polled
   * rarely while the events are live, as before without them.
   */
  options: (pace: RepoPollPace) => { pollMs: () => number; refreshKey: string };
}

export function useRepoWatch(feed: LiveFeed<RepoWatchState> | undefined): RepoWatchHandle {
  const [count, setCount] = useState(0);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  useEffect(() => {
    if (!feed) return;
    const counter = new RepoChangeCounter();
    return feed.subscribe((state) => setCount(counter.see(state)));
  }, [feed]);
  const options = useCallback(
    (pace: RepoPollPace) => ({
      pollMs: () => (feedRef.current?.isLive() ? pace.live : pace.polled),
      refreshKey: String(count),
    }),
    [count],
  );
  return useMemo(() => ({ options }), [options]);
}
