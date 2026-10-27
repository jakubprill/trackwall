import type { RepoCard, RepoTag } from "@trackwall/protocol";
import type { ReactNode } from "react";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { cardGlance } from "@/lib/card-glance";

/** "At a glance" on top of the "Card" tab (ADR-103): the card in a few lines; the sections below have the evidence. */
export function RepoCardGlance({ card, tags }: { card: RepoCard; tags: readonly RepoTag[] }) {
  const glance = cardGlance(card);
  return (
    <Surface label="At a glance">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4 p-3">
        <Fact label="Stack">
          {tags.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Badge key={t.name}>#{t.name}</Badge>
              ))}
            </span>
          )}
          {(glance.stack.length > 0 || tags.length === 0) && (
            <span className="text-muted-foreground text-xs">{glance.stack.join(" · ") || "nothing recognized"}</span>
          )}
        </Fact>
        <Fact label="Apps">
          <span className="font-mono text-sm">{glance.apps.join(", ") || "none"}</span>
        </Fact>
        <Fact label="API">
          <span className="text-sm">{glance.api}</span>
        </Fact>
        <Fact label="Depends on">
          <span className="text-sm">{glance.dependencies}</span>
        </Fact>
      </dl>
    </Surface>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="hud-label">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1">{children}</dd>
    </div>
  );
}
