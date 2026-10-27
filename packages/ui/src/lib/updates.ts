import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countLabel } from "@trackwall/protocol";
import { z } from "zod";
import { formatBytes } from "./format.ts";

/**
 * App updates from GitHub Releases (ADR-53), done by the Tauri shell: `check_update` asks for the latest release,
 * `install_update` downloads it, checks its signature, installs it and restarts the app. Names and shapes are also in
 * `apps/desktop/src-tauri/src/updates.rs` (`apps/desktop/test/shell-events.test.ts` compares them). Only in the Tauri
 * window; in the browser the app is updated by hand.
 */
export const UpdateCheck = z.object({ currentVersion: z.string(), available: z.string().nullable() });
type UpdateCheck = z.infer<typeof UpdateCheck>;

const PROGRESS_EVENT = "update-progress";
/** Where the install is; the shell reports each stage, and the download about four times a second. */
const InstallStage = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("connecting") }),
  z.object({ stage: z.literal("downloading"), downloaded: z.number(), total: z.number().nullable() }),
  z.object({ stage: z.literal("verifying") }),
  z.object({ stage: z.literal("installing") }),
  z.object({ stage: z.literal("restarting") }),
]);
type InstallStage = z.infer<typeof InstallStage>;
type Download = Extract<InstallStage, { stage: "downloading" }>;

/**
 * Silence after which the download counts as stalled. The shell gives up only after 30 s without a single byte, and
 * never on a line that lets a few bytes through now and then, so the user is told earlier and can cancel.
 */
const STALL_AFTER_MS = 20_000;

/** The restart stops the daemon, so the user decides when to install. */
const RESTART_WARNING = "Restarting stops running services and sessions.";

export async function checkUpdate(): Promise<UpdateCheck> {
  return UpdateCheck.parse(await invoke<unknown>("check_update"));
}

/** Rejects when the update failed or was cancelled. Success resolves while the app is already restarting. */
export async function installUpdate(version: string): Promise<void> {
  await invoke("install_update", { version });
}

/** Stops the download; `installUpdate` then rejects with the shell's "The update was cancelled." */
export async function cancelUpdate(): Promise<void> {
  await invoke("cancel_update");
}

/** Calls `onProgress` at each stage of the install; the returned function stops listening. */
export function listenToUpdateProgress(onProgress: (progress: InstallStage) => void): () => void {
  const unlisten = listen<unknown>(PROGRESS_EVENT, (event) => {
    const progress = InstallStage.safeParse(event.payload);
    if (progress.success) onProgress(progress.data);
  });
  return () => void unlisten.then((stop) => stop());
}

/**
 * An install under way. `lastDataAt` is when something last moved (the start, a new stage, more bytes), which tells a
 * stalled download from a slow one; `firstData` is the first report of the download, from which the speed is measured.
 */
export interface Installing {
  state: "installing";
  version: string;
  stage: InstallStage;
  lastDataAt: number;
  firstData?: { at: number; downloaded: number };
}

export type AppUpdate =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "latest"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string }
  /** The user chose to update once no agent is in the middle of a turn (ADR-97); the install starts then. */
  | { state: "waiting"; currentVersion: string; version: string }
  | { state: "check-failed"; message: string }
  | Installing
  | { state: "install-failed"; version: string; message: string };

export type UpdateEvent =
  | { kind: "check-started" }
  | { kind: "checked"; result: UpdateCheck }
  | { kind: "check-failed"; message: string }
  | { kind: "wait-started" }
  | { kind: "wait-cancelled" }
  | { kind: "install-started"; version: string; at: number }
  | { kind: "progress"; progress: InstallStage; at: number }
  | { kind: "install-failed"; message: string };

/**
 * The next update state. A check changes nothing while an install runs, and does not take back an update already
 * found: the strip with "Update and restart" stays through the next periodic check, even one that fails offline.
 */
export function nextUpdate(update: AppUpdate, event: UpdateEvent): AppUpdate {
  const keep = KEPT_BY_CHECK.has(update.state);
  switch (event.kind) {
    case "check-started":
      return keep ? update : { state: "checking" };
    case "checked":
      return checked(update, event.result);
    case "check-failed":
      return keep ? update : { state: "check-failed", message: event.message };
    case "wait-started":
      return update.state === "available" ? { ...update, state: "waiting" } : update;
    case "wait-cancelled":
      return update.state === "waiting" ? { ...update, state: "available" } : update;
    case "install-started":
      return { state: "installing", version: event.version, stage: { stage: "connecting" }, lastDataAt: event.at };
    case "progress":
      return update.state === "installing" ? nextStage(update, event.progress, event.at) : update;
    case "install-failed":
      return update.state === "installing" ? { state: "install-failed", version: update.version, message: event.message } : update;
  }
}

/** States a check does not take back: an install, a found update and one waiting for the agents' turns. */
const KEPT_BY_CHECK: ReadonlySet<AppUpdate["state"]> = new Set(["installing", "available", "waiting"]);

/** A check's result; a newer version found meanwhile does not replace the one being installed or waited for. */
function checked(update: AppUpdate, result: UpdateCheck): AppUpdate {
  if (update.state === "installing" || update.state === "waiting") return update;
  return result.available
    ? { state: "available", currentVersion: result.currentVersion, version: result.available }
    : { state: "latest", currentVersion: result.currentVersion };
}

/** "Trackwall 0.3.1 is available (you have 0.3.0). Restarting stops…" */
export function availableText(update: { currentVersion: string; version: string }): string {
  return `Trackwall ${update.version} is available (you have ${update.currentVersion}). ${RESTART_WARNING}`;
}

/**
 * The version to install now because the update waited for the agents' turns and the last one has ended; `undefined`
 * otherwise, also while the session list has not loaded (`agentsInTurn` is `undefined`).
 */
export function dueAfterTurns(update: AppUpdate, agentsInTurn: number | undefined): string | undefined {
  return update.state === "waiting" && agentsInTurn === 0 ? update.version : undefined;
}

/** "2 agents are in the middle of a turn, which the restart cuts off." */
export function inTurnText(agents: number): string {
  const count = countLabel(agents, { one: "agent is", other: "agents are" });
  return `${count} in the middle of a turn, which the restart cuts off.`;
}

/** "Trackwall 0.3.1 installs once 2 agents finish their turn." */
export function waitingText(update: { version: string }, agents: number): string {
  const count = countLabel(agents, { one: "agent finishes its", other: "agents finish their" });
  return `Trackwall ${update.version} installs once ${count} turn.`;
}

function nextStage(update: Installing, stage: InstallStage, at: number): Installing {
  if (stage.stage !== "downloading") return { ...update, stage, lastDataAt: at };
  const before = update.stage.stage === "downloading" ? update.stage.downloaded : -1;
  return {
    ...update,
    stage,
    lastDataAt: stage.downloaded > before ? at : update.lastDataAt,
    firstData: update.firstData ?? { at, downloaded: stage.downloaded },
  };
}

/**
 * One line for each stage: "Downloading Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%), 2.0 MB/s". The speed is left out
 * while the download is stalled, where it would contradict `stallText`.
 */
export function installingText(update: Installing, now: number): string {
  const { version, stage } = update;
  switch (stage.stage) {
    case "connecting":
      return `Connecting to download Trackwall ${version}…`;
    case "downloading": {
      const speed = isStalled(update, now) ? undefined : downloadSpeed(update, stage);
      return `Downloading Trackwall ${version}: ${progressLabel(stage)}${speed === undefined ? "" : `, ${formatBytes(speed)}/s`}`;
    }
    case "verifying":
      return `Checking the signature of Trackwall ${version}…`;
    case "installing":
      return `Installing Trackwall ${version}…`;
    case "restarting":
      return `Restarting into Trackwall ${version}…`;
  }
}

/** Bytes per second since the first report of the download, once there is at least a second to measure. */
function downloadSpeed({ firstData, lastDataAt }: Installing, { downloaded }: Download): number | undefined {
  if (!firstData || lastDataAt - firstData.at < 1000) return undefined;
  return Math.round(((downloaded - firstData.downloaded) * 1000) / (lastDataAt - firstData.at));
}

/** "12.0 MB of 40.0 MB (30%)", or only the downloaded size when the server did not send the total. */
export function progressLabel({ downloaded, total }: Pick<Download, "downloaded" | "total">): string {
  if (!total) return formatBytes(downloaded);
  return `${formatBytes(downloaded)} of ${formatBytes(total)} (${Math.floor(Math.min(downloaded / total, 1) * 100)}%)`;
}

/** How much of the package is downloaded, from 0 to 1, for the progress bar; `undefined` without a known total. */
export function downloadedFraction(stage: Pick<Download, "downloaded" | "total">): number | undefined {
  return stage.total ? Math.min(stage.downloaded / stage.total, 1) : undefined;
}

/** Whether the package is still on its way, before the signature check. */
function isFetching(update: Installing): boolean {
  return update.stage.stage === "connecting" || update.stage.stage === "downloading";
}

function isStalled(update: Installing, now: number): boolean {
  return isFetching(update) && now - update.lastDataAt >= STALL_AFTER_MS;
}

/** The download can be stopped until the package is in; after that the install runs to the end. */
export function canCancel(update: Installing): boolean {
  return isFetching(update);
}

/** "No data for 25 s…" once the download has had nothing new for `STALL_AFTER_MS`; `undefined` while it moves. */
export function stallText(update: Installing, now: number): string | undefined {
  if (!isStalled(update, now)) return undefined;
  return `No data for ${Math.floor((now - update.lastDataAt) / 1000)} s. A proxy or firewall may be holding the download back; you can cancel and try again later.`;
}
