import { ChevronDown, ChevronRight } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ChosenOption, chosenOptions, moreOptionsOpen } from "@/lib/start-options";
import { StartOptions } from "./StartOptions.tsx";

type Options = ComponentProps<typeof StartOptions>;

/**
 * The options of the New session form (ADR-266): the worktree pill, which decides between a task and a session, stays
 * in sight, and the other pills of `StartOptions` stand folded under "More options". Folded, the button names the
 * options that differ from a plain start; they open on a click, and at once when one of them already differs.
 */
export function FoldedStartOptions({ worktree, disabled, ...more }: Options) {
  const [toggled, setToggled] = useState<boolean>();
  const chosen = chosenOptions({
    approvals: more.approvals?.value,
    model: more.model?.value ?? "",
    javaNavigation: isOn(more.javaNavigation),
    view: more.view?.value ?? "terminal",
    planFirst: isOn(more.planFirst),
    secondAttempt: more.secondAttempt?.value,
  });
  const open = moreOptionsOpen(toggled, chosen);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StartOptions worktree={worktree} disabled={disabled} />
        <MoreOptionsButton open={open} chosen={chosen} onOpen={setToggled} />
      </div>
      {open && <StartOptions {...more} disabled={disabled} />}
    </div>
  );
}

/** Whether a pill that may be unavailable is on, as `StartOptions` shows it. */
function isOn(pill: { value: boolean; unavailable: string | null } | undefined): boolean {
  return pill?.value === true && pill.unavailable === null;
}

function MoreOptionsButton({ open, chosen, onOpen }: { open: boolean; chosen: readonly ChosenOption[]; onOpen: (open: boolean) => void }) {
  return (
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => onOpen(!open)}>
      {open ? <ChevronDown /> : <ChevronRight />} More options
      {!open &&
        chosen.map((option) => (
          <span key={option.text} className={option.risky ? "text-warning" : "text-muted-foreground"}>
            · {option.text}
          </span>
        ))}
    </Button>
  );
}
