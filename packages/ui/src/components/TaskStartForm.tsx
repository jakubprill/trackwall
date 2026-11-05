import { agentsApi, CHANGE_PARTS_MAX, type ChangePart, type CreatedChange, changePartPrompt, changePromptsFit } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { changeStartedPartly, initialParts } from "@/lib/change-start";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { useAction } from "@/lib/use-action";

/** A repo the form offers: its part of the change (the repo and what it has now) and a short detail shown beside it. */
export interface StartCandidate {
  part: ChangePart;
  detail: string;
}

/**
 * A prompt to read and edit and the repos to send it to, from a view that proposes work (aligning a version drift,
 * ADR-196; closing a readiness gap, ADR-208): a task for one repo, a change with one task per repo for more (ADR-171),
 * at most `CHANGE_PARTS_MAX` ticked. Each part's prompt ends with its note. Nothing starts until the user presses Start.
 */
export function TaskStartForm({
  conn,
  title,
  legend,
  promptLabel,
  candidates,
  initialPrompt,
  onStarted,
  onCancel,
}: {
  conn: Connection;
  /** The change's title, which also names its branch. */
  title: string;
  legend: string;
  promptLabel: string;
  candidates: readonly StartCandidate[];
  initialPrompt: string;
  onStarted: (selection: SessionSelection) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(() => initialParts(candidates).map((c) => c.part.repo));
  const [prompt, setPrompt] = useState(initialPrompt);
  const parts = candidates.filter((c) => chosen.includes(c.part.repo)).map((c) => c.part);
  // Parts that did not start are said in the form; the started ones are tasks now, so Start goes away and cannot start them twice.
  const [partly, setPartly] = useState<string>();
  const start = useAction(
    () => startWork(conn, title, prompt, parts),
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
        <legend className="text-muted-foreground mb-1 text-xs">{legend}</legend>
        {candidates.map(({ part, detail }) => (
          <label key={part.repo} className="flex min-w-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary size-4 shrink-0"
              checked={chosen.includes(part.repo)}
              disabled={full && !chosen.includes(part.repo)}
              onChange={() => toggle(part.repo)}
            />
            <span className="truncate font-mono">{part.repo}</span>
            <span className="text-muted-foreground truncate font-mono">{detail}</span>
          </label>
        ))}
        {full && candidates.length > CHANGE_PARTS_MAX && (
          <p className="text-muted-foreground text-xs">A change takes at most {CHANGE_PARTS_MAX} repos; do the rest in a second one.</p>
        )}
      </fieldset>
      <Textarea aria-label={promptLabel} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} />
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

async function startWork(conn: Connection, title: string, prompt: string, parts: ChangePart[]): Promise<CreatedChange> {
  const [first, ...rest] = parts;
  if (first === undefined) throw new Error("Choose a repo.");
  if (rest.length > 0) return post(conn, agentsApi.createChange, { title, prompt, parts, approvals: "ask" });
  const task = await post(conn, agentsApi.createTask, { repo: first.repo, prompt: changePartPrompt(prompt, first), approvals: "ask" });
  return { tasks: [task], failed: [] };
}
