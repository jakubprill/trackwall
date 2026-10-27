import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TESTED_COPILOT_CLI_VERSION } from "@trackwall/protocol";
import { createFacade } from "../src/facade.ts";
import { trustedFolderOf } from "../src/modules/doctor/copilot-trust.ts";
import { copilotVersionOutcome, Doctor, type DoctorDeps } from "../src/modules/doctor/doctor.ts";
import { compareVersions, versionIn } from "../src/modules/doctor/version.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const fakeCopilot = join(import.meta.dir, "fixtures", "fake-copilot-session.ts");
const printVersion = join(import.meta.dir, "fixtures", "print-version.ts");
const NOW = new Date("2026-10-27T20:00:00.000Z");

interface Setup {
  /** `false`: no Copilot CLI in `PATH`; otherwise the fake Copilot CLI, which says the tested version. */
  copilot: boolean;
  /** What `mise --version` prints; `null`: no mise. */
  mise: string | null;
  /** Copilot CLI's `config.json` as written (`<projects>` is replaced by the projects folder); `null`: no file. */
  copilotConfig: string | null;
  authErrors?: Record<string, string>;
}

/** A facade on a fresh state directory, with the fake Copilot CLI and a mise that prints its version, or none of them. */
function doctorFacade(o: Setup) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-doctor-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-projects-"));
  const copilotHome = mkdtempSync(join(tmpdir(), "trackwall-doctor-copilot-"));
  if (o.copilotConfig !== null)
    writeFileSync(join(copilotHome, "config.json"), o.copilotConfig.replace("<projects>", JSON.stringify(projects).slice(1, -1)));
  const facade = createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: o.mise === null ? ["trackwall-test-no-mise"] : [process.execPath, printVersion, o.mise],
    copilotCommand: o.copilot ? [process.execPath, fakeCopilot] : ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({ authErrors: o.authErrors }).clis,
    userEnv: async () => ({ ...process.env, COPILOT_HOME: copilotHome }),
    log: () => {},
  });
  return { facade, home, projects, copilotHome };
}

const trusting = '{"trustedFolders":["<projects>"]}';

describe("doctor", () => {
  test("on a computer with everything in place every check is ok, in a fixed order", async () => {
    const { facade, projects } = doctorFacade({ copilot: true, mise: "2026.10.1 linux-x64", copilotConfig: trusting });
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
    const { facade } = doctorFacade({ copilot: false, mise: null, copilotConfig: null });
    const report = await facade.doctor.run();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["projects-folder", "fail"],
      ["git", "ok"],
      ["copilot-cli", "fail"],
      ["mise", "warn"],
    ]);
    expect(report.checks[0]?.summary).toBe("No projects folder is set.");
    expect(report.checks[2]?.summary).toBe("Copilot CLI (trackwall-test-no-copilot) not found in PATH.");
    expect(report.checks[3]?.summary).toBe("mise: program trackwall-test-no-mise not found in PATH");
    expect(report.checks.every((c) => c.status === "ok" || (c.fix ?? "").length > 0)).toBe(true);
  });

  test("a broken workspace.yaml is named by the projects folder check, and the report still comes", async () => {
    const { facade, home } = doctorFacade({ copilot: true, mise: "2026.10.1", copilotConfig: null });
    writeFileSync(join(home, "workspace.yaml"), "projectsDir: 42\nrepoHosts: 42\n");
    const checks = (await facade.doctor.run()).checks;
    expect(checks[0]?.id).toBe("projects-folder");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.summary).toStartWith("The workspace settings could not be read: ");
    expect(checks[0]?.summary).toContain("workspace.yaml is invalid");
    expect(checks.filter((c) => c.id === "github-cli" || c.id === "gitlab-cli").map((c) => c.status)).toEqual(["fail", "fail"]);
  });

  test.each([
    ['{"trustedFolders":["/somewhere/else"]}', "Copilot CLI does not trust the projects folder; it asks before working in each repo."],
    [null, "Copilot CLI does not trust the projects folder; it asks before working in each repo."],
    ["{ not json", "could not be read: not valid JSON."],
    ['{"trustedFolders":"<projects>"}', "could not be read: trustedFolders is not a list of folders."],
  ])("Copilot CLI's config %j is a warning that names the folder and the file to add it to", async (config, summary) => {
    const { facade, projects, copilotHome } = doctorFacade({ copilot: true, mise: "2026.10.1", copilotConfig: config });
    await facade.workspace.setProjectsDir(projects);
    const check = (await facade.doctor.run()).checks.find((c) => c.id === "copilot-trusted-folder");
    expect(check?.status).toBe("warn");
    expect(check?.summary).toEndWith(summary);
    expect(check?.fix).toBe(
      `Add ${projects} to "trustedFolders" in ${join(copilotHome, "config.json")}, so Copilot CLI stops asking for every repo and task.`,
    );
  });

  test("gh not signed in to two repo hosts names both with their login commands; a kind without hosts is not checked", async () => {
    const { facade } = doctorFacade({
      copilot: true,
      mise: "2026.10.1",
      copilotConfig: null,
      authErrors: { "a.example.org": "not logged in", "b.example.org": "token expired" },
    });
    facade.workspace.setRepoHosts([
      { kind: "github", host: "github.com" },
      { kind: "github", host: "a.example.org" },
      { kind: "github", host: "b.example.org" },
    ]);
    const checks = (await facade.doctor.run()).checks;
    expect(checks.find((c) => c.id === "github-cli")).toEqual({
      id: "github-cli",
      status: "fail",
      summary: "gh is not signed in to a.example.org: not logged in; b.example.org: token expired",
      fix: "Run `gh auth login --hostname a.example.org`, then `gh auth login --hostname b.example.org` in a terminal.",
    });
    expect(checks.some((c) => c.id === "gitlab-cli")).toBe(false);
  });

  test("a program's error goes into its check as one line, and a check that throws fails alone", async () => {
    const deps: DoctorDeps = {
      env: async () => process.env,
      run: () => Promise.reject(new Error(`mise: broken install\n${"x".repeat(16_000)}`)),
      gitVersion: () => Promise.reject(new Error("program git not found in PATH")),
      signedIn: () => Promise.resolve(),
      resolveCopilot: () => ({ program: "copilot", args: [] }),
      mise: ["mise"],
      projectsDir: async () => null,
      repoHosts: () => {
        throw new Error("workspace.yaml is invalid: repoHosts");
      },
      now: () => NOW,
    };
    const report = await new Doctor(deps).run();
    expect(report.checkedAt).toBe(NOW.toISOString());
    expect(report.checks.map((c) => [c.id, c.status, c.summary])).toEqual([
      ["projects-folder", "fail", "No projects folder is set."],
      ["git", "fail", "git: program git not found in PATH"],
      ["copilot-cli", "fail", "Copilot CLI: mise: broken install"],
      ["mise", "warn", "mise: mise: broken install"],
      ["github-cli", "fail", "workspace.yaml is invalid: repoHosts"],
      ["gitlab-cli", "fail", "workspace.yaml is invalid: repoHosts"],
    ]);
  });
});

describe("program versions", () => {
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

  test("a Copilot CLI older than the tested version is a warning; the tested or a newer one is ok", () => {
    expect(copilotVersionOutcome("1.0.90").status).toBe("warn");
    expect(copilotVersionOutcome(TESTED_COPILOT_CLI_VERSION).summary).toBe(`Copilot CLI ${TESTED_COPILOT_CLI_VERSION}`);
    expect(copilotVersionOutcome("9.0.0")).toEqual({
      status: "ok",
      summary: `Copilot CLI 9.0.0 (Trackwall is tested with ${TESTED_COPILOT_CLI_VERSION})`,
      fix: null,
    });
    expect(copilotVersionOutcome(null).status).toBe("warn");
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
