import { describe, expect, test } from "bun:test";
import { FIRST_SETTINGS_CATEGORY, SETTINGS_CATEGORIES, settingsCategory } from "../src/lib/settings-categories.ts";

describe("Settings categories", () => {
  test("the list shows Workspace, Repo hosts, Agents, App, Files and Diagnostics in this order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.label)).toEqual(["Workspace", "Repo hosts", "Agents", "App", "Files", "Diagnostics"]);
  });

  test("Files shows every config file, then the local config of every repo", () => {
    expect(settingsCategory("files").sections).toEqual(["config-files", "local-config-repos"]);
  });

  test("every section is in exactly one category", () => {
    const sections = SETTINGS_CATEGORIES.flatMap((c) => c.sections);
    expect(new Set(sections).size).toBe(sections.length);
  });

  test("the daemon's state and Trackwall's errors are under Diagnostics, connecting Copilot CLI under Agents", () => {
    expect(settingsCategory("diagnostics").sections).toEqual(["doctor", "daemon", "trackwall-errors"]);
    expect(settingsCategory("agents").sections).toContain("copilot-cli");
  });

  test("the session profile is under Agents, next to connecting Copilot CLI", () => {
    expect(settingsCategory("agents").sections).toEqual(["copilot-cli", "session-profile", "java-navigation"]);
  });

  test("how Home draws its scene is under App, with the other settings of this computer", () => {
    expect(settingsCategory("app").sections).toContain("home-scene");
  });

  test("where the desktop app's daemon runs is under App, after starting at sign-in", () => {
    expect(settingsCategory("app").sections).toEqual(["start-at-sign-in", "remote-daemon", "updates", "home-scene"]);
  });

  test("Settings opens on Workspace, with the projects folder first", () => {
    expect(FIRST_SETTINGS_CATEGORY).toBe("workspace");
    expect(settingsCategory(FIRST_SETTINGS_CATEGORY).sections[0]).toBe("folders");
  });
});
