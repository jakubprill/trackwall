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
    expect(settingsCategory("diagnostics").sections).toEqual(["doctor", "container-health", "daemon", "trackwall-errors"]);
    expect(settingsCategory("agents").sections).toContain("copilot-cli");
  });

  test("Agents holds only settings, in the order of their groups: the tasks' settings, the supervisor's, then the model provider and other clients", () => {
    expect(settingsCategory("agents").sections).toEqual([
      "sandbox",
      "auto-review",
      "always-allow",
      "task-token-budget",
      "running-tasks-warning",
      "retry-model",
      "java-navigation",
      "supervisor-model",
      "supervisor-changes-code",
      "session-profile",
      "copilot-cli",
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

  test("App starts with the desktop app (sign-in, the screen, where the daemon runs, updates), then the browser and VS Code, then how it looks", () => {
    expect(settingsCategory("app").sections).toEqual([
      "start-at-sign-in",
      "keep-screen-on",
      "remote-daemon",
      "updates",
      "browser-notifications",
      "vscode-extension",
      "theme",
      "home-scene",
    ]);
  });

  test("Settings opens on Get started until a session exists, and on Workspace with the projects folder first after that", () => {
    expect(firstSettingsCategory(undefined, null)).toBe("get-started");
    expect(firstSettingsCategory(0, 0)).toBe("get-started");
    expect(firstSettingsCategory(3, null)).toBe("workspace");
    expect(firstSettingsCategory(3, 0)).toBe("workspace");
    expect(settingsCategory("workspace").sections[0]).toBe("projects-folder");
  });

  test("Settings opens on Get started also after a session exists, while the doctor's last run left a step open", () => {
    expect(firstSettingsCategory(3, 1)).toBe("get-started");
  });
});
