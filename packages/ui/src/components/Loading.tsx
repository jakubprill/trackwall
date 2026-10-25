/** One place for the look of the "waiting for the daemon" state; the messages are plain sentences, not HUD labels. */
export function Loading({ text = "Loading…" }: { text?: string }) {
  return <p className="text-muted-foreground text-sm">{text}</p>;
}
