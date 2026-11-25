import { describe, expect, test } from "bun:test";
import type { SettingsRestoreItem } from "@trackwall/protocol";
import { initiallyTicked, restoreGroups, restoreLines } from "../src/lib/settings-restore.ts";

const item = (id: string, trust: boolean, problem: string | null = null): SettingsRestoreItem => ({
  id,
  label: id,
  trust,
  current: null,
  restored: "",
  stillMasked: false,
  problem,
});

describe("restoring the settings from the workspace store", () => {
  test("only plain items without a problem start ticked; what agents may run waits for the user's own tick", () => {
    const items = [
      item("workspace:starredRepos", false),
      item("workspace:toolPermissions", true),
      item("copilot:mcp-config.json", true),
      item("workspace:repoHosts", false, "repoHosts is not a list"),
    ];

    expect([...initiallyTicked(items)]).toEqual(["workspace:starredRepos"]);
    expect(restoreGroups(items).trust.map((i) => i.id)).toEqual(["workspace:toolPermissions", "copilot:mcp-config.json"]);
  });

  test("the lines show what is kept, what goes and what the store brings", () => {
    expect(restoreLines("model: gpt-5\ntheme: dark\nfont: 14\n", "model: gpt-5\ntheme: light\nfont: 14\n")).toEqual([
      { kind: "same", text: "model: gpt-5" },
      { kind: "removed", text: "theme: dark" },
      { kind: "added", text: "theme: light" },
      { kind: "same", text: "font: 14" },
    ]);
  });

  test("a file this computer does not have is all brought by the store", () => {
    expect(restoreLines(null, "Answer in English.\n")).toEqual([{ kind: "added", text: "Answer in English." }]);
  });
});
