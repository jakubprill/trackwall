import { miseApi } from "@trackwall/protocol";
import { ListPlus } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The convention tasks file (ADR-157) offered to a repo without mise tasks: `setup`, `build` and `test` for Maven, Gradle
 * and npm, written into the projects folder for every repo there on the user's click, which also trusts it.
 */
export function ConventionTasks({ conn, onWritten }: { conn: Connection; onWritten: () => void }) {
  const load = useCallback(() => post(conn, miseApi.conventionTasks, {}), [conn]);
  const state = useRemote(load);
  const write = useAction(
    () => post(conn, miseApi.writeConventionTasks, {}),
    () => {
      state.reload();
      onWritten();
    },
  );
  if (!state.data) return null;
  if (state.data.state === "changed") {
    return (
      <p className="text-muted-foreground text-xs break-all">
        The convention tasks file {state.data.path} has been changed by hand, so Trackwall leaves it as it is.
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm">
        Trackwall can add convention tasks for every repo in the projects folder that has none of its own: setup, build and test for Maven,
        Gradle and npm projects, so Verify and agents can build and test this repo. test takes a test filter. A repo's own mise task of the
        same name always wins.
      </p>
      <p className="text-muted-foreground font-mono text-xs break-all">{state.data.path}</p>
      <Button variant="outline" size="sm" onClick={write.run} disabled={write.pending}>
        <ListPlus /> {state.data.state === "absent" ? "Add convention tasks (and trust them)" : "Trust the convention tasks again"}
      </Button>
      {write.error && <p className="text-destructive text-xs whitespace-pre-wrap">{write.error}</p>}
    </div>
  );
}
