import { describe, expect, test } from "bun:test";
import { firstSettingsCategory, SETTINGS_CATEGORIES, SETTINGS_GROUP_LABELS, settingsCategory } from "../src/lib/settings-categories.ts";

describe("Settings categories", () => {
  test("the list shows Get started, then what you set (Workspace, Repo hosts, Agents, App), then what you read (Usage, Files, Diagnostics)", () => {
    expect(SETTINGS_CATEGORIES.map((c) => [SETTINGS_GROUP_LABELS[c.group], c.label])).toEqual([
      [null, "Get started"],
      ["Settings", "Workspace"],
      ["Settings", "Repo hosts"],
      ["Settings", "Agents"],
      ["Settings", "App"],
      ["Reports", "Usage"],
      ["Reports", "Files"],
      ["Reports", "Diagnostics"],
    ]);
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

  test("Agents holds only settings: connecting Copilot CLI, the session profile, the supervisor's model and whether it changes code, the retry model, the token budget, the running tasks warning, the sandbox, the automatic review and Java navigation", () => {
    expect(settingsCategory("agents").sections).toEqual([
      "copilot-cli",
      "session-profile",
      "supervisor-model",
      "supervisor-changes-code",
      "retry-model",
      "task-token-budget",
      "running-tasks-warning",
      "always-allow",
      "sandbox",
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

  test("the theme is under App, right before the Home scene, the other way this computer's Trackwall looks", () => {
    expect(settingsCategory("app").sections.slice(-2)).toEqual(["theme", "home-scene"]);
  });

  test("keeping the screen on is under App, after starting at sign-in, then where the daemon runs, notifications in the browser and the VS Code extension", () => {
    expect(settingsCategory("app").sections).toEqual([
      "start-at-sign-in",
      "keep-screen-on",
      "remote-daemon",
      "browser-notifications",
      "vscode-extension",
      "updates",
      "theme",
      "home-scene",
    ]);
  });

  test("Settings opens on Get started until a session exists, and on Workspace with the projects folder first after that", () => {
    expect(firstSettingsCategory(undefined)).toBe("get-started");
    expect(firstSettingsCategory(0)).toBe("get-started");
    expect(firstSettingsCategory(3)).toBe("workspace");
    expect(settingsCategory("workspace").sections[0]).toBe("folders");
  });
});
