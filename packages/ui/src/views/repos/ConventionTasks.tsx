import { miseApi } from "@trackwall/protocol";
import { ListPlus } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The convention tasks file (ADR-157): `setup`, `build` and `test` for Maven, Gradle and npm, written into the projects
 * folder for every repo there on the user's click, which also trusts it. `offer`: for a repo missing one of them, shown
 * while the file is absent, or a line when it differs from Trackwall's. `repair`: for a repo mise refuses as untrusted,
 * shown while the file is Trackwall's, since a failed trust of the file makes mise refuse every repo below it.
 */
export function ConventionTasks({ conn, mode, onWritten }: { conn: Connection; mode: "offer" | "repair"; onWritten: () => void }) {
  const load = useCallback(() => post(conn, miseApi.conventionTasks, {}), [conn]);
  const state = useRemote(load);
  const write = useAction(
    () => post(conn, miseApi.writeConventionTasks, {}),
    () => {
      state.reload();
      onWritten();
    },
  );
  if (!state.data || state.data.state !== (mode === "offer" ? "absent" : "current")) {
    return mode === "offer" && state.data?.state === "changed" ? (
      <p className="text-muted-foreground text-xs break-all">
        The convention tasks file {state.data.path} differs from what this Trackwall writes, so Trackwall leaves it as it is.
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm">
        {mode === "repair" && "If mise refuses the convention tasks file in the projects folder, trust it here. "}
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
