import { CHANGE_PART_NOTE_MAX, TASK_TITLE_MAX } from "@trackwall/protocol";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Connection } from "@/lib/connection";
import { type ChangePartDraft, changePartsOfForm, mayAddPart } from "@/lib/new-session";
import { ChangeOrderHints } from "./ChangeOrderHints.tsx";

/**
 * The other repos of a task, which make it a change (ADR-171): one more task per repo, all on one branch named after
 * the change's title, in the order their merge requests are to be merged, starting with the repo chosen above.
 */
export function ChangeParts({
  conn,
  repos,
  repo,
  parts,
  title,
  disabled,
  onParts,
  onTitle,
  partly,
}: {
  conn: Connection;
  repos: readonly { id: string }[];
  /** The repo chosen above, the change's first part. */
  repo: string;
  parts: readonly ChangePartDraft[];
  title: string;
  disabled: boolean;
  onParts: (parts: ChangePartDraft[]) => void;
  onTitle: (title: string) => void;
  /** What started of the change when some parts could not. */
  partly: string | undefined;
}) {
  const others = repos.filter((r) => r.id !== repo);
  // The hints follow the parts the change will have, so they load the graph only once a second repo is chosen.
  const chosen = changePartsOfForm(repo, parts);
  const set = (index: number, part: Partial<ChangePartDraft>) => onParts(parts.map((p, i) => (i === index ? { ...p, ...part } : p)));
  const add = () => onParts([...parts, { repo: others.find((r) => !parts.some((p) => p.repo === r.id))?.id ?? "", note: "" }]);
  if (others.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {parts.length > 0 && (
        <>
          <p className="text-muted-foreground max-w-prose text-xs">
            A change across several repos: one task per repo, all on one branch named after the title, merged in this order, starting with{" "}
            <span className="text-foreground font-mono">{repo}</span>. Put the repo the others build on first.
          </p>
          <Input
            aria-label="Title of the change"
            placeholder="Title of the change, e.g. Refund API"
            value={title}
            maxLength={TASK_TITLE_MAX}
            onChange={(e) => onTitle(e.target.value)}
            disabled={disabled}
          />
        </>
      )}
      {parts.map((part, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Repo ${index + 2} of the change`}
            value={part.repo}
            onChange={(e) => set(index, { repo: e.target.value })}
            disabled={disabled}
            className="border-input bg-card h-9 w-fit min-w-48 rounded-md border px-3 text-sm"
          >
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <Input
            aria-label={`What ${part.repo} has to do`}
            placeholder="Optional: what this repo has to do"
            value={part.note}
            maxLength={CHANGE_PART_NOTE_MAX}
            onChange={(e) => set(index, { note: e.target.value })}
            disabled={disabled}
            className="min-w-48 flex-1"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${part.repo} from the change`}
            onClick={() => onParts(parts.filter((_, i) => i !== index))}
            disabled={disabled}
          >
            <X />
          </Button>
        </div>
      ))}
      {chosen.length > 1 && <ChangeOrderHints conn={conn} repos={chosen.map((part) => part.repo)} />}
      {mayAddPart(parts, others.length) && (
        <Button variant="ghost" className="w-fit" onClick={add} disabled={disabled}>
          <Plus /> Add a repo
        </Button>
      )}
      {partly && <p className="text-destructive text-sm whitespace-pre-wrap">{partly}</p>}
    </div>
  );
}
