import { PROJECTS_FOLDER_PLACE } from "@trackwall/protocol";
import { FolderShell } from "@/components/FolderShell";
import type { Connection } from "@/lib/connection";

/**
 * The shell of the whole projects folder (ADR-185): every repo under one folder, which in a dev container is its volume,
 * for what no single repo is the place of (a clone by hand, a look across repos, the workspace's `.trackwall`).
 */
export function ProjectsFolderShell({ conn, projectsDir }: { conn: Connection; projectsDir: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="hud-label">Projects folder</span>
        <h1 className="text-xl font-semibold tracking-tight">Shell</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <FolderShell conn={conn} place={PROJECTS_FOLDER_PLACE} folder={projectsDir} />
      </div>
    </div>
  );
}
