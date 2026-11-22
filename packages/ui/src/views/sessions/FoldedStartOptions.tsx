import { type ComponentProps, useState } from "react";
import { FoldButton } from "@/components/FoldButton";
import { Tip } from "@/components/Tip";
import type { Connection } from "@/lib/connection";
import { chosenOptions, moreOptionsOpen } from "@/lib/start-options";
import { StartOptions } from "./StartOptions.tsx";

type Options = ComponentProps<typeof StartOptions>;

/**
 * The options of the New session form (ADR-266): the worktree pill, which decides between a task and a session, stays
 * in sight, with its tip under it (ADR-296), and the other pills of `StartOptions` stand folded under "More options",
 * with the tip of Plan first under them where the form offers it.
 * Folded, the button names the options that differ from a plain start; they open on a click, and at once when one of
 * them already differs.
 */
export function FoldedStartOptions({ conn, worktree, disabled, ...more }: Options & { conn: Connection }) {
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
        <FoldButton open={open} onOpen={setToggled}>
          More options
          {!open &&
            chosen.map((option) => (
              <span key={option.text} className={option.risky ? "text-warning" : "text-muted-foreground"}>
                · {option.text}
              </span>
            ))}
        </FoldButton>
      </div>
      {worktree && <Tip conn={conn} tip="own-worktree" />}
      {open && <StartOptions {...more} disabled={disabled} />}
      {open && more.planFirst && <Tip conn={conn} tip="plan-first" />}
    </div>
  );
}

/** Whether a pill that may be unavailable is on, as `StartOptions` shows it. */
function isOn(pill: { value: boolean; unavailable: string | null } | undefined): boolean {
  return pill?.value === true && pill.unavailable === null;
}
