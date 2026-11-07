import { Button } from "@/components/ui/button";
import type { FilingChoice } from "@/lib/inbox-triage";

/**
 * The projects an idea can be filed in, each a button; a project whose items name one of the idea's repos says so. With
 * `numbered`, the first nine show the digit that picks them from the keyboard.
 */
export function FilingChoices({
  choices,
  numbered,
  disabled,
  onFile,
}: {
  choices: readonly FilingChoice[];
  numbered: boolean;
  disabled: boolean;
  onFile: (project: string) => void;
}) {
  if (choices.length === 0) {
    return <p className="text-muted-foreground text-xs">No active project yet. Add one in the left column.</p>;
  }
  return (
    <ul aria-label="Projects to file it in" className="flex flex-col gap-1">
      {choices.map((choice, at) => (
        <li key={choice.project.id}>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onFile(choice.project.id)}
            className="w-full justify-start"
          >
            {numbered && at < 9 && <kbd className="text-muted-foreground font-mono text-xs">{at + 1}</kbd>}
            <span className="min-w-0 flex-1 truncate text-left">{choice.project.title}</span>
            {choice.sharedRepos.length > 0 && (
              <span className="text-muted-foreground truncate text-xs">also works in {choice.sharedRepos.join(", ")}</span>
            )}
          </Button>
        </li>
      ))}
    </ul>
  );
}
