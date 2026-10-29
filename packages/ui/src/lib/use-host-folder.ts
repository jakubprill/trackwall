import { useCallback, useContext } from "react";
import { inDesktopShell } from "./app-window.ts";
import { DaemonPlaceContext } from "./desktop.ts";
import { hostProjectsFolder, segmentsBelow } from "./host-folder.ts";
import { IS_MAC, IS_WINDOWS } from "./platform.ts";
import { useRemote } from "./use-remote.ts";

/**
 * The folder names that show `path` in Explorer or Finder through the projects folder on this computer (ADR-131), or
 * `undefined` when there is no such way: the daemon shows folders itself, the page is not the desktop app on Windows or
 * macOS, no folder is set, or the path is not below the projects folder.
 */
export function useHostFolder(projectsDir: string | null | undefined, path: string): string[] | undefined {
  const { desktop } = useContext(DaemonPlaceContext);
  const base = !desktop && inDesktopShell() && (IS_WINDOWS || IS_MAC) ? projectsDir : undefined;
  const load = useCallback(() => hostProjectsFolder(), []);
  const saved = useRemote(typeof base === "string" ? load : undefined);
  return typeof base === "string" && saved.data ? segmentsBelow(base, path) : undefined;
}
