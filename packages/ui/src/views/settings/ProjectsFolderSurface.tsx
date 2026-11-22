import type { WorkspaceSettings } from "@trackwall/protocol";
import { ProjectsFolderForm } from "@/components/ProjectsFolderForm";
import type { Connection } from "@/lib/connection";
import type { RemoteHandle } from "@/lib/use-remote";

/** The projects folder (ADR-18) in "Settings > Workspace": what it is for, and the form "Get started" shows too. */
export function ProjectsFolderSurface(props: {
  conn: Connection;
  settings: RemoteHandle<WorkspaceSettings>;
  onSaved: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">
        The Repos view shows every git repo directly inside this folder. A repo cloned into it appears in the list on its own.
      </p>
      <ProjectsFolderForm {...props} />
    </div>
  );
}
