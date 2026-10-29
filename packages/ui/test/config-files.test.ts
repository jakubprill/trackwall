import { describe, expect, test } from "bun:test";
import type { ConfigEntry, ConfigFilesReport } from "@trackwall/protocol";
import {
  configEntryStatus,
  configGroups,
  configProblemCount,
  configWriterLabel,
  docsUrl,
  workspaceKeyChangedIn,
} from "../src/lib/config-files.ts";

const report: ConfigFilesReport = {
  stateDir: { path: "C:\\Users\\me\\.trackwall", from: "default" },
  places: { state: "C:\\Users\\me\\.trackwall", projects: "C:\\Users\\me\\Dev", copilot: "C:\\Users\\me\\.copilot" },
  entries: [
    {
      id: "workspace-file",
      name: "workspace.yaml",
      path: "C:\\Users\\me\\.trackwall\\workspace.yaml",
      state: "invalid",
      detail: "1 key cannot be read: graph",
    },
    { id: "tasks-file", name: "tasks.json", path: "C:\\Users\\me\\.trackwall\\tasks.json", state: "present", detail: "2 KB" },
    {
      id: "local-config-store",
      name: ".trackwall/local",
      path: "C:\\Users\\me\\Dev\\.trackwall\\local",
      state: "present",
      detail: "on this computer only",
    },
    {
      id: "copilot-config",
      name: "config.json",
      path: "C:\\Users\\me\\.copilot\\config.json",
      state: "present",
      detail: "trusts C:\\Users\\me\\Dev",
    },
  ],
  workspaceKeys: [],
  unknownWorkspaceKeys: [],
};

describe("the Files category", () => {
  test("entries are grouped by where they lie, with Trackwall's own memory apart", () => {
    const groups = configGroups(report);
    expect(groups.map((g) => [g.title, g.dir, g.entries.map((e) => e.id), g.internal.map((e) => e.id)])).toEqual([
      ["Trackwall", "C:\\Users\\me\\.trackwall", ["workspace-file"], ["tasks-file"]],
      ["Projects folder", "C:\\Users\\me\\Dev", ["local-config-store"], []],
      ["Copilot CLI", "C:\\Users\\me\\.copilot", ["copilot-config"], []],
    ]);
    expect(groups[0]?.description).toEndWith("This is the default; TRACKWALL_HOME chooses another folder.");
  });

  test("the state folder says what chose it", () => {
    const fromEnv = configGroups({ ...report, stateDir: { ...report.stateDir, from: "env" } });
    expect(fromEnv[0]?.description).toEndWith("TRACKWALL_HOME chose this folder.");
  });

  test("a folder Trackwall makes when needed is not yet created, a file you write is not there, and one it cannot read is an error", () => {
    const entry = (id: ConfigEntry["id"], state: ConfigEntry["state"]): ConfigEntry => ({ id, name: "x", path: "/x", state, detail: null });
    expect(configEntryStatus(entry("removed-repos-dir", "missing"))).toEqual({ label: "not created yet" });
    expect(configEntryStatus(entry("projects-mise-config", "missing"))).toEqual({ label: "not there" });
    expect(configEntryStatus(entry("workspace-file", "invalid"))).toEqual({ tone: "error", label: "cannot be read" });
    expect(configEntryStatus(entry("copilot-config", "present"))).toEqual({ tone: "ok", label: "found" });
  });

  test("who writes an entry, and where a key is changed", () => {
    expect(report.entries.map(configWriterLabel)).toEqual(["you", "Trackwall", "Trackwall", "Copilot CLI"]);
    expect(workspaceKeyChangedIn("projectsDir")).toBe("Settings › Workspace");
    expect(workspaceKeyChangedIn("repoHosts")).toBe("Settings › Repo hosts");
    expect(workspaceKeyChangedIn("toolPermissions")).toBe("by hand");
  });

  test("a docs link goes to the feature's page, and the header counts the entries that cannot be read", () => {
    expect(docsUrl("local-config")).toBe("https://jakubprill.github.io/trackwall/features/local-config");
    expect(configProblemCount(report)).toBe(1);
  });
});
