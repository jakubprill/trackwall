import { type Repo, type Session, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { EditorButton } from "@/components/EditorButton";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { repoSessionRepo } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * Opening a repo session's repo in VS Code (ADR-175), as the repo's card does (`open-editor`); other sessions get no
 * button. The repo list comes without asking git (ADR-113), for the path a container's VS Code link needs (ADR-121).
 */
export function SessionEditorButton({ conn, session }: { conn: Connection; session: Session }) {
  const repoId = repoSessionRepo(session);
  const load = useCallback(() => post(conn, workspaceApi.entries, {}), [conn]);
  const list = useRemote(repoId === null ? undefined : load);
  const repo = list.data?.repos.find((entry) => entry.id === repoId);
  return repo ? <RepoEditorButton conn={conn} repo={repo} /> : null;
}

/** The button for a repo on the list; the error shows next to it. */
function RepoEditorButton({ conn, repo }: { conn: Connection; repo: Repo }) {
  const openEditor = useAction(
    () => post(conn, workspaceApi.openEditor, { repo: repo.id }),
    () => {},
  );
  return (
    <>
      {openEditor.error && <span className="text-destructive max-w-xs truncate text-xs">{openEditor.error}</span>}
      <EditorButton path={repo.path} label="VS Code" onOpen={openEditor.run} disabled={openEditor.pending} />
    </>
  );
}
