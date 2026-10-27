import { countLabel, type TrackwallError, type TrackwallErrorSource } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";

/** How the Settings list names the part of Trackwall an error came from (ADR-94). */
const SOURCE_NAMES: Record<TrackwallErrorSource, string> = { daemon: "Daemon", shell: "Desktop app", ui: "Window" };

/** The frames the list shows under an error; the rest stays in the journal. */
const SHOWN_FRAMES = 3;

/** One error of the journal as the Settings list shows it. */
export function errorJournalEntry(error: TrackwallError, now: Date) {
  return {
    title: `${SOURCE_NAMES[error.source]} · ${error.area.replace(/^[a-z]+:/, "")}`,
    detail: `${error.kind} · ${countLabel(error.count, { one: "time", other: "times" })} · last ${relativeTime(error.lastSeen, now)} · ${error.version}`,
    message: error.message,
    frames: error.frames.slice(0, SHOWN_FRAMES),
  };
}
