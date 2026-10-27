import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import { RepoHostsForm } from "./RepoHostsForm.tsx";

/** Repo hosts (ADR-19) have their own request: a bad `repoHosts` entry does not block the projects folder and vice versa. */
export function RepoHostsSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.repoHosts, {}), [conn]);
  const hosts = useRemote(load);
  return (
    <Surface label="Repo hosts">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          The Repos view searches these hosts and clones a repo into your projects folder in one click. Trackwall asks them through the glab
          (GitLab) and gh (GitHub) CLIs you are signed in to, so it never stores a token.
        </p>
        {hosts.error && <ErrorWithRetry message={hosts.error} onRetry={hosts.reload} />}
        {!hosts.data && !hosts.error && <Loading />}
        {hosts.data && <RepoHostsForm conn={conn} initial={hosts.data} />}
        {/* A bad `repoHosts` typed by hand is fixed by saving the list again. */}
        {hosts.errorCode === "invalid_config" && <RepoHostsForm conn={conn} initial={[]} />}
      </div>
    </Surface>
  );
}
