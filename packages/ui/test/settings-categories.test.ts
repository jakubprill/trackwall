import { describe, expect, test } from "bun:test";
import { FIRST_SETTINGS_CATEGORY, SETTINGS_CATEGORIES, settingsCategory } from "../src/lib/settings-categories.ts";

describe("Settings categories", () => {
  test("the list shows Workspace, Repo hosts, Agents, Usage, App, Files and Diagnostics in this order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.label)).toEqual(["Workspace", "Repo hosts", "Agents", "Usage", "App", "Files", "Diagnostics"]);
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

  test("Agents holds only settings: connecting Copilot CLI, the session profile, the supervisor's model, the automatic review and Java navigation", () => {
    expect(settingsCategory("agents").sections).toEqual([
      "copilot-cli",
      "session-profile",
      "supervisor-model",
      "auto-review",
      "java-navigation",
    ]);
  });

  test("what Copilot CLI used, how each model did on tasks and the MCP calls agents made have a category of their own, Usage, the only one as wide as the view", () => {
    expect(settingsCategory("usage").sections).toEqual(["copilot-usage", "model-stats", "mcp-calls"]);
    expect(SETTINGS_CATEGORIES.filter((c) => c.wide).map((c) => c.id)).toEqual(["usage"]);
  });

  test("how Home draws its scene is under App, with the other settings of this computer", () => {
    expect(settingsCategory("app").sections).toContain("home-scene");
  });

  test("keeping the screen on is under App, after starting at sign-in, then where the daemon runs, notifications in the browser and the VS Code extension", () => {
    expect(settingsCategory("app").sections).toEqual([
      "start-at-sign-in",
      "keep-screen-on",
      "remote-daemon",
      "browser-notifications",
      "vscode-extension",
      "updates",
      "home-scene",
    ]);
  });

  test("Settings opens on Workspace, with the projects folder first", () => {
    expect(FIRST_SETTINGS_CATEGORY).toBe("workspace");
    expect(settingsCategory(FIRST_SETTINGS_CATEGORY).sections[0]).toBe("folders");
  });
});
