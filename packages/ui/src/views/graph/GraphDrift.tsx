import {
  agentsApi,
  CHANGE_PARTS_MAX,
  type ChangePart,
  type CreatedChange,
  changePartPrompt,
  changePromptsFit,
  type DriftedRepo,
  evidenceLabel,
  type VersionDrift,
} from "@trackwall/protocol";
import { Wrench } from "lucide-react";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { changeStartedPartly } from "@/lib/change-start";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";
import {
  alignPart,
  alignPrompt,
  alignTitle,
  driftKey,
  driftKindLabel,
  driftSubject,
  initialAlignRepos,
  onTarget,
  reposToAlign,
} from "@/lib/version-drift";

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

/** Starts the alignment: a task for one repo, a change with one task per repo for more (ADR-171). */
async function startAlignment(conn: Connection, drift: VersionDrift, prompt: string, parts: ChangePart[]): Promise<CreatedChange> {
  const [first, ...rest] = parts;
  if (first === undefined) throw new Error("Choose a repo to align.");
  if (rest.length > 0) return post(conn, agentsApi.createChange, { title: alignTitle(drift), prompt, parts, approvals: "ask" });
  const task = await post(conn, agentsApi.createTask, { repo: first.repo, prompt: changePartPrompt(prompt, first), approvals: "ask" });
  return { tasks: [task], failed: [] };
}

/**
 * The form of the alignment: the repos behind the target, at most `CHANGE_PARTS_MAX` ticked (a change's limit), and the
 * prompt for the user to edit; each part's prompt ends with what its repo has now and where.
 */
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
  const behind = reposToAlign(drift);
  const [chosen, setChosen] = useState(() => initialAlignRepos(drift));
  const [prompt, setPrompt] = useState(() => alignPrompt(drift));
  const parts = behind.filter((r) => chosen.includes(r.repo)).map(alignPart);
  // Parts that did not start are said in the form; the started ones are tasks now, so Start goes away and cannot start them twice.
  const [partly, setPartly] = useState<string>();
  const start = useAction(
    () => startAlignment(conn, drift, prompt, parts),
    ({ tasks, failed }) => {
      const first = tasks[0];
      if (failed.length === 0 && first) return onStarted({ kind: "task", id: first.id });
      setPartly(
        changeStartedPartly(
          tasks.map((t) => t.repo),
          failed,
        ),
      );
    },
  );
  if (partly !== undefined)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-warning text-xs whitespace-pre-line">{partly}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  const full = chosen.length >= CHANGE_PARTS_MAX;
  const fits = changePromptsFit(prompt, parts);
  const toggle = (repo: string) => setChosen((now) => (now.includes(repo) ? now.filter((r) => r !== repo) : [...now, repo]));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start.run();
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground mb-1 text-xs">Repos to move to {drift.target}</legend>
        {behind.map((r) => (
          <label key={r.repo} className="flex min-w-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary size-4 shrink-0"
              checked={chosen.includes(r.repo)}
              disabled={full && !chosen.includes(r.repo)}
              onChange={() => toggle(r.repo)}
            />
            <span className="truncate font-mono">{r.repo}</span>
            <span className="text-muted-foreground font-mono">{r.versions.join(", ")}</span>
          </label>
        ))}
        {full && behind.length > CHANGE_PARTS_MAX && (
          <p className="text-muted-foreground text-xs">A change takes at most {CHANGE_PARTS_MAX} repos; align the rest in a second one.</p>
        )}
      </fieldset>
      <Textarea aria-label={`Prompt to align ${driftSubject(drift)}`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} />
      {!fits && <p className="text-destructive text-xs">The prompt is too long for a task.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={start.pending || parts.length === 0 || prompt.trim() === "" || !fits}>
          {start.pending ? "Starting…" : parts.length > 1 ? `Start change in ${parts.length} repos` : "Start task"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={start.pending}>
          Cancel
        </Button>
        {start.error && <span className="text-destructive text-xs whitespace-pre-line">{start.error}</span>}
      </div>
    </form>
  );
}
