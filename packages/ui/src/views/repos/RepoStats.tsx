import type { RepoStatusOk } from "@trackwall/protocol";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { relativeTime } from "@/lib/format";
import { branchLabel, repoStatusTone } from "@/lib/repo-status";

/**
 * State tiles in the repo header: branch, tracking branch, working directory and last commit (§4.5). Working directory
 * changes lead to the "Changes" tab (ADR-34), so that the number alone is not a dead end.
 */
export function RepoStats({ status, onShowChanges }: { status: RepoStatusOk; onShowChanges: () => void }) {
  const state = repoStatusTone(status);
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
      <Stat label="Branch">
        <span className="font-mono" title={branchLabel(status)}>
          {branchLabel(status)}
        </span>
      </Stat>
      <Stat label="Upstream">
        {status.upstream ? (
          <span className="flex items-center gap-2 font-mono" title={`compared with ${status.upstream.name}`}>
            <span className="flex items-center gap-0.5">
              <ArrowUp className="text-muted-foreground size-3.5" />
              {status.upstream.ahead}
            </span>
            <span className="flex items-center gap-0.5">
              <ArrowDown className="text-muted-foreground size-3.5" />
              {status.upstream.behind}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">{status.upstream.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
      </Stat>
      <Stat label="Working tree">
        {status.changes > 0 ? (
          <button type="button" className="hover:underline" onClick={onShowChanges} title="Show the changes">
            <StatusLabel tone={state.tone} label={state.label} />
          </button>
        ) : (
          <StatusLabel tone={state.tone} label={state.label} />
        )}
      </Stat>
      <Stat label="Latest commit">
        {status.head ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate" title={status.head.subject}>
              {status.head.subject}
            </span>
            <span className="text-muted-foreground truncate text-xs" title={status.head.date}>
              {status.head.author}, {relativeTime(status.head.date, new Date())}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">no commits</span>
        )}
      </Stat>
    </dl>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="surface flex min-w-0 flex-col gap-1 px-3 py-2">
      <dt className="hud-label">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  );
}
