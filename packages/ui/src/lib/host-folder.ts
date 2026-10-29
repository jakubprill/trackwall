import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * The projects folder as this computer sees it (ADR-131): a daemon in a container keeps the repos in a volume, which
 * Explorer reaches under another path. The desktop app keeps that path and shows a repo there itself; the commands are in
 * `apps/desktop/src-tauri/src/host_folder.rs`. Tauri window only.
 */
const GET_COMMAND = "host_projects_folder";
const SET_COMMAND = "set_host_projects_folder";
const SHOW_COMMAND = "show_in_host_folder";

/** The saved folder, or `null` when none is set. */
export async function hostProjectsFolder(): Promise<string | null> {
  return z
    .string()
    .nullable()
    .parse(await invoke<unknown>(GET_COMMAND));
}

/** Saves the folder, which has to exist; `null` forgets it. */
export function setHostProjectsFolder(path: string | null): Promise<void> {
  return invoke(SET_COMMAND, { path });
}

/** Shows the folder at these names below the saved projects folder in the system's file manager. */
export function showInHostFolder(segments: string[]): Promise<void> {
  return invoke(SHOW_COMMAND, { segments });
}

/**
 * The folder names of `path` below the daemon's projects folder, both paths of the daemon's own Linux system; `undefined`
 * when it is not below it, since the saved folder on this computer stands only for the projects folder.
 */
export function segmentsBelow(projectsDir: string, path: string): string[] | undefined {
  const base = projectsDir.replace(/\/+$/, "");
  if (base === "" || !path.startsWith(`${base}/`)) return undefined;
  const segments = path
    .slice(base.length + 1)
    .split("/")
    .filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) return undefined;
  return segments;
}
