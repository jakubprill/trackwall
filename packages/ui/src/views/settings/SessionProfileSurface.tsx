import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

/**
 * The session profile (ADR-136): the mise environment only Copilot CLI sessions start with, e.g. `byok` for another model
 * provider in `mise.byok.toml`. It applies to the next session start; a running session shows the change with a restart.
 */
export function SessionProfileSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

  async function save(profile: string | null) {
    await post(conn, workspaceApi.setSessionProfile, { profile });
    settings.reload();
  }

  const data = settings.data;
  return (
    <Surface label="Session profile">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          A mise environment that only sessions start with. With byok, sessions also read mise.byok.toml, for example from your projects
          folder, which can point Copilot CLI at another model provider and hold its key encrypted. Mise tasks and services never get it.
          Empty means sessions start with your usual mise config.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <PathForm
            key={data.sessionProfile ?? ""}
            label="Session profile"
            placeholder="byok"
            configKey="sessionProfile"
            initialPath={data.sessionProfile ?? ""}
            configFile={data.configFile}
            folder={false}
            save={(profile) => save(profile)}
            resetLabel="No profile"
            reset={data.sessionProfile === null && !data.sessionProfileProblem ? undefined : () => save(null)}
          />
        )}
        {data?.sessionProfileProblem && <p className="text-destructive text-xs break-words">{data.sessionProfileProblem}</p>}
      </div>
    </Surface>
  );
}
