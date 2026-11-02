import type { ChangePart } from "@trackwall/protocol";
import { toggle } from "@/lib/set-toggle";

/**
 * The repos of a proposed change (ADR-171) in the order their merge requests are to be merged, each with the note its
 * part gets: every repo is named, and the user unticks the ones the change should leave out before starting it.
 */
export function ChangeProposalParts({
  title,
  parts,
  dropped,
  disabled,
  onDropped,
}: {
  title: string;
  parts: readonly ChangePart[];
  /** The repos the user unticked. */
  dropped: ReadonlySet<string>;
  disabled: boolean;
  onDropped: (dropped: ReadonlySet<string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground max-w-prose text-xs">
        A task per ticked repo, all on one branch named after “{title}”, merged in this order. Each gets the prompt below with its own note.
        Keep at least two.
      </p>
      <ol aria-label={`Repos of “${title}”`} className="flex flex-col gap-1">
        {parts.map((part, index) => (
          <li key={part.repo}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary mt-1 size-4 shrink-0"
                checked={!dropped.has(part.repo)}
                disabled={disabled}
                onChange={() => onDropped(toggle(dropped, part.repo))}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono">
                  {index + 1}. {part.repo}
                </span>
                {part.note !== "" && <span className="text-muted-foreground text-xs whitespace-pre-wrap">{part.note}</span>}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </div>
  );
}
