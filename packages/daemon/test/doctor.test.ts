import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TESTED_COPILOT_CLI_VERSION } from "@trackwall/protocol";
import { createFacade } from "../src/facade.ts";
import { trustedFolderOf } from "../src/modules/doctor/copilot-trust.ts";
import { copilotVersionCheck, Doctor, type DoctorDeps } from "../src/modules/doctor/doctor.ts";
import { compareVersions, versionIn } from "../src/modules/doctor/version.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const printVersion = join(import.meta.dir, "fixtures", "print-version.ts");
const NOW = new Date("2026-10-27T20:00:00.000Z");

/** A facade on a fresh state directory, with Copilot CLI and mise that print the given versions (`null`: missing). */
function doctorFacade(o: { copilot: string | null; mise: string | null; trusted: string[] | null; authErrors?: Record<string, string> }) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-doctor-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-projects-"));
  const copilotHome = mkdtempSync(join(tmpdir(), "trackwall-doctor-copilot-"));
  if (o.trusted)
    writeFileSync(
      join(copilotHome, "config.json"),
      JSON.stringify({ trustedFolders: o.trusted.map((t) => t.replace("<projects>", projects)) }),
    );
  const hosting = fakeHostingClis({ authErrors: o.authErrors });
  const facade = createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: o.mise === null ? ["trackwall-test-no-mise"] : [process.execPath, printVersion, o.mise],
    copilotCommand: o.copilot === null ? ["trackwall-test-no-copilot"] : [process.execPath, printVersion, o.copilot],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: hosting.clis,
    userEnv: async () => ({ ...process.env, COPILOT_HOME: copilotHome }),
    log: () => {},
  });
  return { facade, projects, copilotHome };
}

describe("doctor", () => {
  test("on a computer with everything in place every check is ok, in a fixed order", async () => {
    const { facade, projects } = doctorFacade({
      copilot: `GitHub Copilot CLI ${TESTED_COPILOT_CLI_VERSION}.`,
      mise: "2026.10.1 linux-x64",
      trusted: ["<projects>"],
    });
    await facade.workspace.setProjectsDir(projects);
    facade.workspace.setRepoHosts([{ kind: "github", host: "github.com" }]);
    const report = await facade.doctor.run();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["projects-folder", "ok"],
      ["git", "ok"],
      ["copilot-cli", "ok"],
      ["copilot-trusted-folder", "ok"],
      ["mise", "ok"],
      ["github-cli", "ok"],
    ]);
    expect(report.checks.find((c) => c.id === "copilot-cli")?.summary).toBe(`Copilot CLI ${TESTED_COPILOT_CLI_VERSION}`);
    expect(report.checks.find((c) => c.id === "mise")?.summary).toBe("mise 2026.10.1");
    expect(report.checks.find((c) => c.id === "git")?.summary).toMatch(/^git \d+\.\d+\.\d+$/);
    expect(report.checks.every((c) => c.fix === null)).toBe(true);
  });

  test("without a projects folder, Copilot CLI or mise each says what to do, and the trust check waits for the folder", async () => {
    const { facade } = doctorFacade({ copilot: null, mise: null, trusted: null });
    const report = await facade.doctor.run();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["projects-folder", "fail"],
      ["git", "ok"],
      ["copilot-cli", "fail"],
      ["mise", "warn"],
    ]);
    expect(report.checks[0]?.summary).toBe("No projects folder is set.");
    expect(report.checks[2]?.summary).toBe("Copilot CLI (trackwall-test-no-copilot) not found in PATH.");
    expect(report.checks.every((c) => c.status === "ok" || (c.fix ?? "").length > 0)).toBe(true);
  });

  test("a projects folder Copilot CLI does not trust is a warning that names the folder and Copilot CLI's config file", async () => {
    const { facade, projects, copilotHome } = doctorFacade({ copilot: "1.0.103", mise: "2026.10.1", trusted: ["/somewhere/else"] });
    await facade.workspace.setProjectsDir(projects);
    const check = (await facade.doctor.run()).checks.find((c) => c.id === "copilot-trusted-folder");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toBe(
      `Add ${projects} to "trustedFolders" in ${join(copilotHome, "config.json")}, so Copilot CLI stops asking for every repo and task.`,
    );
  });

  test("gh or glab not signed in to a repo host fails with the host and the login command; a kind without hosts is not checked", async () => {
    const { facade } = doctorFacade({
      copilot: "1.0.103",
      mise: "2026.10.1",
      trusted: null,
      authErrors: { "git.example.org": "You are not logged into any GitHub hosts." },
    });
    facade.workspace.setRepoHosts([
      { kind: "github", host: "github.com" },
      { kind: "github", host: "git.example.org" },
    ]);
    const checks = (await facade.doctor.run()).checks;
    expect(checks.find((c) => c.id === "github-cli")).toEqual({
      id: "github-cli",
      status: "fail",
      summary: "gh is not signed in to git.example.org: You are not logged into any GitHub hosts.",
      fix: "Run `gh auth login --hostname git.example.org` in a terminal.",
    });
    expect(checks.some((c) => c.id === "gitlab-cli")).toBe(false);
  });

  test("a check whose program fails gives its message and does not fail the report", async () => {
    const deps: DoctorDeps = {
      env: async () => process.env,
      run: () => Promise.reject(new Error("program mise not found in PATH")),
      gitVersion: () => Promise.reject(new Error("program git not found in PATH")),
      signedIn: () => Promise.resolve(),
      copilot: ["copilot"],
      findCopilot: () => undefined,
      mise: ["mise"],
      projectsDir: async () => null,
      repoHosts: () => [],
      now: () => NOW,
    };
    const report = await new Doctor(deps).run();
    expect(report.checkedAt).toBe(NOW.toISOString());
    expect(report.checks.find((c) => c.id === "git")).toEqual({
      id: "git",
      status: "fail",
      summary: "git: program git not found in PATH",
      fix: "Install Git (git-scm.com) and restart Trackwall.",
    });
  });
});

describe("Copilot CLI version", () => {
  test.each([
    ["GitHub Copilot CLI 1.0.103.\nRun 'copilot update' to check for updates.", "1.0.103"],
    ["git version 2.47.1.windows.1", "2.47.1"],
    ["2026.10.1 macos-arm64 (2026-10-20)", "2026.10.1"],
    ["no version here", null],
  ])("the first x.y.z of %j is %j", (output, version) => {
    expect(versionIn(output)).toBe(version);
  });

  test("versions compare by number, not as text", () => {
    expect(compareVersions("1.0.99", "1.0.103")).toBeLessThan(0);
    expect(compareVersions("1.1.0", "1.0.103")).toBeGreaterThan(0);
    expect(compareVersions("1.0.103", "1.0.103")).toBe(0);
  });

  test("older than the tested version is a warning; the tested or a newer one is ok", () => {
    expect(copilotVersionCheck("1.0.90").status).toBe("warn");
    expect(copilotVersionCheck(TESTED_COPILOT_CLI_VERSION).summary).toBe(`Copilot CLI ${TESTED_COPILOT_CLI_VERSION}`);
    expect(copilotVersionCheck("9.0.0")).toEqual({
      id: "copilot-cli",
      status: "ok",
      summary: `Copilot CLI 9.0.0 (Trackwall is tested with ${TESTED_COPILOT_CLI_VERSION})`,
      fix: null,
    });
    expect(copilotVersionCheck(null).status).toBe("warn");
  });
});

describe("Copilot CLI trusted folders", () => {
  test("a trusted folder covers the folders under it, but not a folder that only starts with its name", () => {
    const root = join(tmpdir(), "dev");
    expect(trustedFolderOf(join(root, "projects"), [root])).toBe(root);
    expect(trustedFolderOf(root, [root])).toBe(root);
    expect(trustedFolderOf(`${root}-old`, [root])).toBeNull();
  });
});
