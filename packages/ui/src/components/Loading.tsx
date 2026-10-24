/** Jedno miejsce dla wyglądu stanu „czekam na daemona”; komunikaty to zwykłe zdania, nie etykiety HUD. */
export function Loading({ text = "Loading…" }: { text?: string }) {
  return <p className="text-muted-foreground text-sm">{text}</p>;
}
