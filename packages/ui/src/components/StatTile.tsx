import type { ReactNode } from "react";

/** One number of a row of numbers in a `<dl>`: a HUD caption over the value, on a glass tile (repo stats, Copilot usage). */
export function StatTile({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="surface flex min-w-0 flex-col gap-1 px-3 py-2" title={title}>
      <dt className="hud-label">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  );
}
