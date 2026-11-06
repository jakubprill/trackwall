import { type KnowledgeListEntry, knowledgeApi, type Task, trackwallDirLabel } from "@trackwall/protocol";
import { Check } from "lucide-react";
import { RemoveForGood } from "@/components/RemoveForGood";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { KIND_LABELS, knowledgeAuthor, knowledgeWarnings, mayBelongInRepo } from "@/lib/knowledge";
import { reloadOnRefusal } from "@/lib/reload-on-refusal";
import { useAction } from "@/lib/use-action";

/**
 * The selected knowledge entry in the right column of Plan (ADR-216): the whole fact, its repos, who wrote it and when,
 * and for one waiting for approval its evidence, what to check twice and "Approve this version". Approving is here, next
 * to the evidence, and one entry at a time, since every approved entry reaches the instructions of later sessions.
 */
export function KnowledgePanel({
  conn,
  entry,
  tasks,
  onChanged,
  onRemoved,
}: {
  conn: Connection;
  entry: KnowledgeListEntry;
  tasks: readonly Task[];
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const approve = useAction(
    () => reloadOnRefusal(post(conn, knowledgeApi.approve, { name: entry.name, digest: entry.digest }), onChanged),
    onChanged,
  );
  const warnings = entry.approved ? [] : knowledgeWarnings(entry);
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="hud-label">Workspace knowledge</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{KIND_LABELS[entry.kind]}</Badge>
        {entry.approved ? (
          <span className="text-muted-foreground text-xs">approved, read by sessions</span>
        ) : (
          <Badge>needs your approval</Badge>
        )}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{entry.text}</p>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>Repos</dt>
        <dd className="font-mono">{entry.repos.length === 0 ? "whole workspace" : entry.repos.join(", ")}</dd>
        <dt>Written by</dt>
        <dd>
          {knowledgeAuthor(entry, tasks)} · {relativeTime(entry.updatedAt, new Date())}
        </dd>
        <dt>File</dt>
        <dd className="font-mono break-all">{`${trackwallDirLabel("knowledge")}/${entry.name}.md`}</dd>
      </dl>
      {!entry.approved && entry.evidence !== "" && (
        <section aria-label="Evidence" className="flex flex-col gap-1">
          <h4 className="hud-label">Evidence</h4>
          <p className="text-muted-foreground text-xs whitespace-pre-wrap break-words">{entry.evidence}</p>
        </section>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-warning text-xs">
          {warning}
        </p>
      ))}
      {!entry.approved && mayBelongInRepo(entry) && (
        <p className="text-muted-foreground text-xs">
          This is about one repo. If its team would agree, it may belong in that repo's own agent instructions instead, where everyone reads
          it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!entry.approved && (
          <Button size="sm" onClick={() => approve.run()} disabled={approve.pending}>
            <Check /> Approve this version
          </Button>
        )}
        <RemoveForGood
          remove={() => post(conn, knowledgeApi.remove, { name: entry.name })}
          disabled={approve.pending}
          onRemoved={onRemoved}
        />
      </div>
      {approve.error && <p className="text-destructive text-xs whitespace-pre-wrap">{approve.error}</p>}
    </div>
  );
}
