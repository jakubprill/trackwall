import {
  CONFIG_ENTRIES,
  type ConfigEntry,
  type ConfigFilesReport,
  type ConfigPlace,
  type ConfigWriter,
  type DocsPage,
  TRACKWALL_DOCS_URL,
  WORKSPACE_KEYS,
  type WorkspaceKey,
} from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * The Files category of Settings (ADR-108) in the UI: the entries grouped by where they lie, each with what it is for and a
 * link to its documentation page, and the keys of `workspace.yaml` with where to change them. Pure functions, tested in
 * `test/config-files.test.ts`.
 */

export interface ConfigGroup {
  place: ConfigPlace;
  title: string;
  /** What the place is, in a sentence above its entries. */
  description: string;
  /** `null` while the projects folder is not set. */
  dir: string | null;
  /** The entries the user sets or looks at. */
  entries: ConfigEntry[];
  /** Trackwall's own memory, folded into one line. */
  internal: ConfigEntry[];
}

const PLACES: Record<ConfigPlace, { title: string; description: (from: ConfigFilesReport["stateDir"]["from"]) => string }> = {
  state: {
    title: "Trackwall",
    description: (from) =>
      `Trackwall's own folder: your workspace settings and what Trackwall remembers between starts. ${STATE_DIR_FROM[from]}`,
  },
  projects: {
    title: "Projects folder",
    description: () =>
      "The folder with all your repos. Trackwall keeps its working folders here too, with names that start with a dot, so they never show up as repos and sit on the same disk.",
  },
  copilot: {
    title: "Copilot CLI",
    description: () => "Copilot CLI's own settings. Trackwall only reads them and never writes here.",
  },
};

const STATE_DIR_FROM: Record<ConfigFilesReport["stateDir"]["from"], string> = {
  default: "This is the default; TRACKWALL_HOME chooses another folder.",
  env: "TRACKWALL_HOME chose this folder.",
  flag: "The daemon's --home option chose this folder.",
};

export function configGroups(report: ConfigFilesReport): ConfigGroup[] {
  return (["state", "projects", "copilot"] as const).map((place) => {
    const inPlace = report.entries.filter((e) => CONFIG_ENTRIES[e.id].place === place);
    return {
      place,
      title: PLACES[place].title,
      description: PLACES[place].description(report.stateDir.from),
      dir: report.places[place],
      entries: inPlace.filter((e) => !CONFIG_ENTRIES[e.id].internal),
      internal: inPlace.filter((e) => CONFIG_ENTRIES[e.id].internal),
    };
  });
}

const WRITERS: Record<ConfigWriter, string> = { you: "you", trackwall: "Trackwall", "copilot-cli": "Copilot CLI" };

export function configWriterLabel(entry: ConfigEntry): string {
  return WRITERS[CONFIG_ENTRIES[entry.id].writer];
}

/**
 * The state as a word with a tone. A missing folder Trackwall makes when it needs it is normal, so it is no warning;
 * a missing file the user writes is only a note.
 */
export function configEntryStatus(entry: ConfigEntry): { tone?: StatusTone; label: string } {
  switch (entry.state) {
    case "present":
      return { tone: "ok", label: "found" };
    case "invalid":
      return { tone: "error", label: "cannot be read" };
    case "missing":
      return { label: CONFIG_ENTRIES[entry.id].writer === "trackwall" ? "not created yet" : "not there" };
  }
}

export function docsUrl(page: DocsPage): string {
  return `${TRACKWALL_DOCS_URL}features/${page}`;
}

/** Where a key is changed: its Settings category, or by hand in the file. */
export function workspaceKeyChangedIn(key: WorkspaceKey): string {
  switch (WORKSPACE_KEYS[key].settings) {
    case "workspace":
      return "Settings › Workspace";
    case "repo-hosts":
      return "Settings › Repo hosts";
    case null:
      return "by hand";
  }
}

/** How many entries cannot be read, for the section's header; a key that cannot be read makes `workspace.yaml` one of them. */
export function configProblemCount(report: ConfigFilesReport): number {
  return report.entries.filter((e) => e.state === "invalid").length;
}
