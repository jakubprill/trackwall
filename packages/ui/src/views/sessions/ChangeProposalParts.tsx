import { CHANGE_PART_NOTE_MAX, type ChangePart } from "@trackwall/protocol";
import { Input } from "@/components/ui/input";
import { toggle } from "@/lib/set-toggle";

/**
 * The repos of a proposed change (ADR-171) in the order their merge requests are to be merged, each with the note its
 * part gets: every repo is named, and before starting it the user unticks the ones the change should leave out and may
 * edit a note, which is the agent's text like the prompt.
 */
export function ChangeProposalParts({
  title,
  parts,
  dropped,
  notes,
  disabled,
  onDropped,
  onNotes,
}: {
  title: string;
  parts: readonly ChangePart[];
  /** The repos the user unticked. */
  dropped: ReadonlySet<string>;
  /** The notes the user edited, by repo. */
  notes: ReadonlyMap<string, string>;
  disabled: boolean;
  onDropped: (dropped: ReadonlySet<string>) => void;
  onNotes: (notes: ReadonlyMap<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground max-w-prose text-xs">
        A task per ticked repo, all on one branch named after “{title}”, merged in this order. Each gets the prompt below with its own note,
        which you can edit. Keep at least two.
      </p>
      <ol aria-label={`Repos of “${title}”`} className="flex flex-col gap-1">
        {parts.map((part, index) => (
          <li key={part.repo} className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-40 items-center gap-2 font-mono text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4 shrink-0"
                checked={!dropped.has(part.repo)}
                disabled={disabled}
                onChange={() => onDropped(toggle(dropped, part.repo))}
              />
              {index + 1}. {part.repo}
            </label>
            <Input
              aria-label={`What ${part.repo} has to do`}
              placeholder="No note: the prompt alone"
              value={notes.get(part.repo) ?? part.note}
              maxLength={CHANGE_PART_NOTE_MAX}
              disabled={disabled || dropped.has(part.repo)}
              onChange={(e) => onNotes(new Map(notes).set(part.repo, e.target.value))}
              className="min-w-48 flex-1"
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
