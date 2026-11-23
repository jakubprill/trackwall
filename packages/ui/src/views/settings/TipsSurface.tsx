import { Button } from "@/components/ui/button";
import { TIP_IDS } from "@/lib/tips";
import { useTips } from "@/lib/tips-controller";
import { Choice } from "./Choice.tsx";

const SHOWN = [
  { value: "on", label: "On", hint: "A tip under a feature the first time you meet it, and What's new above the views after an update." },
  { value: "off", label: "Off", hint: "Neither. The release notes still list every change." },
] as const;

/**
 * Tips and What's new on this computer (ADR-296): whether they show, which every window follows at once, and the tips
 * already seen shown again, each the next time its place is on screen.
 */
export function TipsSurface() {
  const { tips, state } = useTips();
  return (
    <div className="flex flex-col gap-4 p-4">
      <Choice
        name="tips"
        legend="On this computer"
        options={SHOWN}
        value={state.on ? "on" : "off"}
        onChange={(value) => tips?.setOn(value === "on")}
      />
      {state.on && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">
            {state.seen} of {TIP_IDS.length} tips seen on this computer.
          </p>
          <Button variant="outline" size="sm" disabled={state.seen === 0} onClick={() => tips?.showAgain()}>
            Show the tips again
          </Button>
        </div>
      )}
    </div>
  );
}
