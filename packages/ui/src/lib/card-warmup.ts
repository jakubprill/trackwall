import type { CardWarmupProgress } from "@trackwall/protocol";

/** The card warm-up (ADR-63) in words: the "Repo cards" row of the Daemon panel. */
export function warmupLabel(warmup: CardWarmupProgress): string {
  return warmup.running ? `computing ${warmup.done} of ${warmup.total}` : "up to date";
}

/** What "Overview" says while the first graph waits for the cards. */
export function graphLoadingText(warmup: CardWarmupProgress | undefined): string {
  return warmup?.running ? `Building the graph from repo cards, ${warmupLabel(warmup)}…` : "Building the graph from repo cards…";
}
