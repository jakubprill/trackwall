import { type DriftedRepo, evidenceLabel, type VersionDrift } from "@trackwall/protocol";
import { Wrench } from "lucide-react";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { TaskStartForm } from "@/components/TaskStartForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { alignPart, alignPrompt, alignTitle, driftKey, driftKindLabel, driftSubject, onTarget, reposToAlign } from "@/lib/version-drift";

/**
 * Version drift in the "Overview" view (ADR-196): what the repos use in different versions, each repo with its
 * versions and the lines that give them, and "Align", which starts a task or a change in the repos behind the newest
 * version. Nothing starts until the user reads the prompt and presses Start.
 */
export function DriftSection({
  conn,
  drift,
  onSelect,
  onOpenInSessions,
}: {
  conn: Connection;
  drift: readonly VersionDrift[];
  onSelect: (repo: string) => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  // The drift being aligned as it was when "Align" was pressed: a refresh of the graph does not change the form under the user.
  const [aligning, setAligning] = useState<VersionDrift>();
  if (drift.length === 0) return null;
  return (
    <Surface label="Version drift" meta={drift.length}>
      <ul className="divide-y">
        {drift.map((d) => (
          <li key={driftKey(d)} className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
            <DriftHeading drift={d} />
            <ul className="flex flex-col gap-0.5">
              {d.repos.map((r) => (
                <li key={r.repo} className="flex min-w-0 items-center gap-2 text-xs">
                  <button type="button" onClick={() => onSelect(r.repo)} className="text-primary truncate font-mono hover:underline">
                    {r.repo}
                  </button>
                  <span className={onTarget(d, r) ? "font-mono" : "text-warning font-mono"}>{r.versions.join(", ")}</span>
                </li>
              ))}
            </ul>
            {aligning !== undefined && driftKey(aligning) === driftKey(d) ? (
              <AlignForm
                conn={conn}
                drift={aligning}
                onStarted={(selection) => {
                  setAligning(undefined);
                  onOpenInSessions(selection);
                }}
                onCancel={() => setAligning(undefined)}
              />
            ) : (
              <Button variant="outline" size="sm" className="self-start" onClick={() => setAligning(d)}>
                <Wrench /> Align to {d.target}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Surface>
  );
}

/** The drifts one repo is part of: its versions next to the newest, and the lines that give them. */
export function RepoDriftSection({ drift }: { drift: readonly { drift: VersionDrift; own: DriftedRepo }[] }) {
  return (
    <Surface label="Version drift" meta={drift.length}>
      <ul className="divide-y">
        {drift.map(({ drift: d, own }) => (
          <li key={driftKey(d)} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
            <DriftHeading drift={d} />
            <span className="text-xs">
              Here <span className="font-mono">{own.versions.join(", ")}</span>, newest <span className="font-mono">{d.target}</span>
            </span>
            {own.evidence.map((e) => (
              <span key={`${e.path}:${e.line}:${e.detail}`} className="text-muted-foreground truncate font-mono text-2xs">
                {`${evidenceLabel(e)} ${e.detail}`}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function DriftHeading({ drift }: { drift: VersionDrift }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-sm" title={drift.name}>
        {driftSubject(drift)}
      </span>
      <Badge variant="secondary">{driftKindLabel(drift.kind)}</Badge>
    </span>
  );
}

/** The form of the alignment: the repos behind the target, and the prompt for the user to edit (ADR-196). */
function AlignForm({
  conn,
  drift,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  drift: VersionDrift;
  onStarted: (selection: SessionSelection) => void;
  onCancel: () => void;
}) {
  return (
    <TaskStartForm
      conn={conn}
      title={alignTitle(drift)}
      legend={`Repos to move to ${drift.target}`}
      promptLabel={`Prompt to align ${driftSubject(drift)}`}
      candidates={reposToAlign(drift).map((r) => ({ part: alignPart(r), detail: r.versions.join(", ") }))}
      initialPrompt={alignPrompt(drift)}
      onStarted={onStarted}
      onCancel={onCancel}
    />
  );
}
