import type { ReproTest } from "@trackwall/protocol";
import { FlaskConical, Square } from "lucide-react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { checksTest, reproductionFilterNote, reproductionLabel, reproductionRunsLine, shownCheck } from "@/lib/reproduction";
import { useReproductionCheck } from "@/lib/use-reproduction-check";

/**
 * Trackwall's own check of the agent's reproduction test (ADR-227), under the agent's claim: "Check it" runs the test in a
 * copy of the repo without the fix and then with it, and the line shows the verdict and what each run found. A check of
 * an earlier test the agent named is not shown as one of this test.
 */
export function ReproductionCheck({ conn, task, test }: { conn: Connection; task: string; test: ReproTest }) {
  const state = useReproductionCheck(conn, task);
  const check = shownCheck(state.check, test);
  const running = check?.state === "running";
  const note = check && reproductionFilterNote(check);
  return (
    <section aria-label="Reproduction check" className="mt-1 flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        {check ? (
          <StatusLabel {...reproductionLabel(check)} />
        ) : (
          <span className="text-muted-foreground text-xs">Not checked by Trackwall</span>
        )}
        {check && !checksTest(check, test) && <span className="text-muted-foreground text-xs">of the earlier test {check.test.name}</span>}
        {check && !running && <span className="text-muted-foreground text-xs">{relativeTime(check.startedAt, new Date())}</span>}
        {running ? (
          <Button variant="ghost" size="sm" onClick={state.cancel} disabled={state.cancelling}>
            <Square /> Stop
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={state.start}
            disabled={state.starting}
            title="run the test in a copy of the repo without the task's fix, then with it"
          >
            <FlaskConical /> {check ? "Check again" : "Check it"}
          </Button>
        )}
        {state.error && <span className="text-destructive max-w-xs truncate text-xs">{state.error}</span>}
      </div>
      {check && reproductionRunsLine(check) !== "" && <p className="text-muted-foreground text-xs">{reproductionRunsLine(check)}</p>}
      {check?.message && <p className="text-muted-foreground text-xs">{check.message}</p>}
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </section>
  );
}
