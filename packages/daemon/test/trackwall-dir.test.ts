import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { makeRepo } from "./support/git-repo.ts";

/**
 * Trackwall's folder `.trackwall` in the projects folder (ADR-125) through the real facade, on a real projects folder
 * and real git: made when Trackwall first writes there, and refused when it is a link.
 */
async function setup() {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-dir-"));
  const facade = createFacade({
    home: mkdtempSync(join(tmpdir(), "trackwall-dir-home-")),
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: HOSTING_CLIS,
    userEnv: async () => process.env,
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  return { projects, facade };
}

describe("Trackwall's folder in the projects folder", () => {
  test("a repo's changes show in a projects folder that has no .trackwall yet, and leave its scratch folder empty", async () => {
    const { projects, facade } = await setup();
    const web = makeRepo({ "README.md": "# web\n" }, "web", projects);
    writeFileSync(join(web, "notes.md"), "draft\n");

    const changes = await facade.workspace.changes("web");

    expect(changes.files.map((f) => f.path)).toEqual(["notes.md"]);
    expect(existsSync(join(projects, ".trackwall", "scratch"))).toBe(true);
  });

  test("a repo is not removed into a link in place of .trackwall, and stays where it is", async () => {
    const { projects, facade } = await setup();
    const elsewhere = mkdtempSync(join(tmpdir(), "trackwall-dir-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(projects, ".trackwall"), "junction");
    } catch {
      // A system that does not let the user make links: there is nothing to follow.
      return;
    }
    const docs = makeRepo({ "README.md": "# docs\n" }, "docs", projects);

    await expect(facade.workspace.removeRepo("docs", docs, () => {})).rejects.toThrow("is not a folder (a link?)");

    expect(existsSync(join(docs, "README.md"))).toBe(true);
    expect(existsSync(join(elsewhere, "removed"))).toBe(false);
  });
});
