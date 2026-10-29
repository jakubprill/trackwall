import { useCallback } from "react";
import { inDesktopShell } from "./app-window.ts";
import { hostProjectsFolder, segmentsBelow } from "./host-folder.ts";
import { useRemote } from "./use-remote.ts";

/**
 * The folder names that show `path` in the system's file manager through the projects folder on this computer
 * (ADR-131), or `undefined` when there is no such way: the daemon shows folders itself, the page is not the desktop app,
 * no folder is set, or the path is not below the projects folder.
 */
export function useHostFolder(desktop: boolean, projectsDir: string | null | undefined, path: string): string[] | undefined {
  const asked = !desktop && inDesktopShell() && typeof projectsDir === "string";
  const load = useCallback(() => hostProjectsFolder(), []);
  const saved = useRemote(asked ? load : undefined);
  if (!asked || typeof projectsDir !== "string" || !saved.data) return undefined;
  return segmentsBelow(projectsDir, path);
}
