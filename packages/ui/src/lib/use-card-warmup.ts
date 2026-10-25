import { type CardWarmupProgress, cardsApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/** Polled only while the events are not connected; the progress comes live from them. */
const WARMUP_POLL_MS = 5000;

/** The progress of the card warm-up (ADR-63), live from `cards.warmup.changed`. */
export function useCardWarmup(conn: Connection, live: LiveFeed<CardWarmupProgress> | undefined) {
  const load = useCallback(() => post(conn, cardsApi.warmup, {}), [conn]);
  return useRemote(load, { pollMs: WARMUP_POLL_MS, live });
}
