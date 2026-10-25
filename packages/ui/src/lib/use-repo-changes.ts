import { cardsApi, type RepoChanges } from "@trackwall/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { DaemonEvents, LiveFeed } from "./daemon-events.ts";
import { pollPace, RepoChangeCounter, type RepoPollPace } from "./repo-changes.ts";
import { useRemote } from "./use-remote.ts";

/** Repo changes from the events WebSocket (ADR-63) for the views that show data depending on commits. */
export interface RepoChangesHandle {
  /** Grows with every reported change: a view passes it as `refreshKey` and fetches its data again. */
  key: string;
  /** The poll interval for this pace: rare while the events are live, as before without them. */
  pollMs: (pace: RepoPollPace) => number;
}

export function useRepoChanges(feed: LiveFeed<RepoChanges> | undefined): RepoChangesHandle {
  const [count, setCount] = useState(0);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  useEffect(() => {
    if (!feed) return;
    const counter = new RepoChangeCounter();
    return feed.subscribe((changes) => setCount(counter.see(changes.revision)));
  }, [feed]);
  const pollMs = useCallback((pace: RepoPollPace) => pollPace(pace, feedRef.current?.isLive() ?? false), []);
  return useMemo(() => ({ key: String(count), pollMs }), [count, pollMs]);
}

/** Polled only while the events are not connected; the progress comes live from them. */
const WARMUP_POLL_MS = 5000;

/** The progress of the card warm-up (ADR-63). */
export function useCardWarmup(conn: Connection, events: DaemonEvents | undefined) {
  const load = useCallback(() => post(conn, cardsApi.warmup, {}), [conn]);
  const live = useMemo(() => events?.feed("cards.warmup.changed"), [events]);
  return useRemote(load, { pollMs: WARMUP_POLL_MS, live });
}
