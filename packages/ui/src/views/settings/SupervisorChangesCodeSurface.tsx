import { workspaceApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import { SavedAs } from "./SavedAs.tsx";

/**
 * Whether the supervisor may run commands and change files itself (`supervisor.changesCode`, ADR-78), set here instead
 * of by hand in `workspace.yaml` (ADR-239). Off by default: the supervisor coordinates and every change goes through a
 * task the user approves.
 */
export function SupervisorChangesCodeSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(changesCode: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.setSupervisor, { changesCode });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      settings.reload();
      setBusy(false);
    }
  }

  const data = settings.data;
  return (
    <Surface label="Supervisor changes code">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          The supervisor coordinates: it reads your repos and proposes tasks, but cannot run shell commands or write files, so every change
          goes through a task you approve. Turn this on to let it run commands and edit files itself; it then asks for your approval like
          any other session. It applies from the supervisor's next start.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary size-4 shrink-0"
              checked={data.supervisor.changesCode}
              disabled={busy}
              onChange={(e) => void change(e.target.checked)}
            />
            Let the supervisor run commands and change files
          </label>
        )}
        {data?.supervisorProblem && <p className="text-destructive text-xs break-words">{data.supervisorProblem}</p>}
        {error && <p className="text-destructive text-xs break-words">{error}</p>}
        {data && <SavedAs configKey="supervisor" configFile={data.configFile} />}
      </div>
    </Surface>
  );
}
