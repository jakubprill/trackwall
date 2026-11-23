import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { relativeTime } from "./format.ts";

/**
 * The backups the desktop app downloads by itself (ADR-281): every few hours, while it is connected to a daemon in a dev
 * container, into a folder of this computer, keeping the newest ones. Held by `apps/desktop/src-tauri/src/work_backups.rs`.
 * Tauri window only.
 */
const STATE_COMMAND = "work_backups";
const SHOW_COMMAND = "show_work_backups";

const LastRun = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), at: z.number(), file: z.string() }),
  z.object({ kind: z.literal("notInContainer"), at: z.number() }),
  z.object({ kind: z.literal("failed"), at: z.number(), message: z.string() }),
]);

export const DesktopWorkBackups = z.object({
  folder: z.string(),
  files: z.number().int().nonnegative(),
  keep: z.number().int().positive(),
  everyHours: z.number().int().positive(),
  last: LastRun.nullable(),
});
export type DesktopWorkBackups = z.infer<typeof DesktopWorkBackups>;

export async function desktopWorkBackups(): Promise<DesktopWorkBackups> {
  return DesktopWorkBackups.parse(await invoke<unknown>(STATE_COMMAND));
}

export function showDesktopWorkBackups(): Promise<void> {
  return invoke(SHOW_COMMAND);
}

/** What the app does and did, in one or two sentences under the section's buttons. */
export function desktopWorkBackupsText(state: DesktopWorkBackups, now: Date): string {
  const what = `This app downloads a backup every ${state.everyHours} hours and keeps the newest ${state.keep} in ${state.folder} (${state.files} now).`;
  const last = state.last;
  if (last === null) return `${what} The first one comes a few minutes after the app starts.`;
  const when = relativeTime(new Date(last.at).toISOString(), now);
  if (last.kind === "saved") return `${what} Last saved ${when}: ${last.file}.`;
  if (last.kind === "failed") return `${what} The last try ${when} failed: ${last.message}`;
  return what;
}
