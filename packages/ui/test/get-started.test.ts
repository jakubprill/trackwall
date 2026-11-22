import { describe, expect, test } from "bun:test";
import type { DoctorCheck, DoctorReport } from "@trackwall/protocol";
import {
  doneStepsLine,
  fixCommand,
  getStartedHeadline,
  getStartedInSessions,
  getStartedPlace,
  getStartedPlan,
  goodToHaveSummary,
  stepsLeft,
} from "../src/lib/get-started.ts";

const report = (...checks: DoctorCheck[]): DoctorReport => ({ checkedAt: "2026-11-17T16:00:00.000Z", checks });
const ok = (id: DoctorCheck["id"], summary: string): DoctorCheck => ({ id, status: "ok", summary, fix: null });

/** A new computer: no folder chosen, Copilot CLI not installed, the rest in place. */
const NEW_COMPUTER = report(
  {
    id: "projects-folder",
    status: "fail",
    summary: "No projects folder is set.",
    fix: 'Choose the folder with your repos in "Settings > Workspace".',
  },
  ok("disk-space", "29.0 GB free on the disk of your home folder."),
  ok("git", "git 2.47.1"),
  {
    id: "copilot-cli",
    status: "fail",
    summary: "Copilot CLI (copilot) not found in PATH.",
    fix: "Install GitHub Copilot CLI, sign in by running `copilot` once, and restart Trackwall.",
  },
  ok("network", "github.com and api.githubcopilot.com answer."),
  {
    id: "mise",
    status: "warn",
    summary: "mise: program mise not found in PATH",
    fix: "Install mise (mise.jdx.dev) and restart Trackwall.",
  },
);

/** The same computer once the folder is chosen and Copilot CLI installed: only the trusted folder is left. */
const FOLDER_NOT_TRUSTED = report(
  ok("projects-folder", "/home/me/dev"),
  {
    id: "file-scanning",
    status: "warn",
    summary: "Writing a file takes 9 ms in the projects folder.",
    fix: "Leave it out of real-time scanning.",
  },
  ok("git", "git 2.47.1"),
  ok("copilot-cli", "Copilot CLI 1.0.110"),
  {
    id: "copilot-trusted-folder",
    status: "warn",
    summary: "Copilot CLI does not trust the projects folder; it asks before working in each repo.",
    fix: 'Add /home/me/dev to "trustedFolders" in /home/me/.copilot/config.json, so Copilot CLI stops asking for every repo and task.',
  },
  ok("network", "github.com and api.githubcopilot.com answer."),
  ok("mise", "mise 2026.11.2"),
  {
    id: "gitlab-cli",
    status: "fail",
    summary: "glab is not signed in to gitlab.example.com",
    fix: "Run `glab auth login --hostname gitlab.example.com` in a terminal.",
  },
);

describe("Get started", () => {
  test("a new computer has the folder and Copilot CLI to do, in the order to do them, and the trusted folder waits for the folder", () => {
    const plan = getStartedPlan(NEW_COMPUTER);
    expect(plan.steps.map((s) => [s.title, s.need, s.state])).toEqual([
      ["Projects folder", "needed", "todo"],
      ["Git", "needed", "done"],
      ["Copilot CLI", "needed", "todo"],
      ["Network for sessions", "needed", "done"],
      ["Copilot CLI trusts your projects folder", "recommended", "later"],
    ]);
    expect(plan.ready).toBe(false);
    expect(plan.open).toBe(2);
    expect(getStartedHeadline(plan)).toBe("2 steps left before your first session.");
  });

  test("a step says what the doctor found, and what to do only while it is to do", () => {
    const [folder, git] = getStartedPlan(NEW_COMPUTER).steps;
    expect(folder).toMatchObject({
      summary: "No projects folder is set.",
      fix: 'Choose the folder with your repos in "Settings > Workspace".',
    });
    expect(git).toMatchObject({ summary: "git 2.47.1", fix: null });
  });

  test("with only a recommended step left a session can start, and the headline says what is left", () => {
    const plan = getStartedPlan(FOLDER_NOT_TRUSTED);
    expect(plan.steps.find((s) => s.id === "copilot-trusted-folder")).toMatchObject({ need: "recommended", state: "todo" });
    expect(plan.ready).toBe(true);
    expect(plan.open).toBe(1);
    expect(getStartedHeadline(plan)).toBe("Ready. 1 recommended step is left.");
  });

  test("with every step done the headline says so, and no step waits", () => {
    const plan = getStartedPlan(
      report(
        ok("projects-folder", "/home/me/dev"),
        ok("git", "git 2.47.1"),
        ok("copilot-cli", "Copilot CLI 1.0.110"),
        ok("network", "direct"),
        ok("copilot-trusted-folder", "Copilot CLI trusts /home/me/dev."),
      ),
    );
    expect(plan.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(plan.open).toBe(0);
    expect(getStartedHeadline(plan)).toBe("Ready. Everything Trackwall needs to start a session is in place.");
  });

  test("a needed step that works with a gap, such as an older Copilot CLI, is done and keeps the doctor's sentence about the gap", () => {
    const old: DoctorCheck = {
      id: "copilot-cli",
      status: "warn",
      summary: "Copilot CLI 1.0.90 is older than 1.0.110, which Trackwall is tested with.",
      fix: "Update Copilot CLI.",
    };
    const plan = getStartedPlan(report(ok("projects-folder", "/home/me/dev"), old));
    expect(plan.steps.find((s) => s.id === "copilot-cli")).toMatchObject({ state: "done", summary: old.summary, fix: null });
    expect(plan.ready).toBe(true);
  });

  test("the trusted folder step is not shown when its check did not run although the folder is set", () => {
    const plan = getStartedPlan(report(ok("projects-folder", "/home/me/dev"), ok("git", "git 2.47.1")));
    expect(plan.steps.map((s) => s.id)).toEqual(["projects-folder", "git"]);
  });

  test("git access to the repo hosts is a recommended step, shown only when a repo has a remote to reach", () => {
    const unreachable: DoctorCheck = {
      id: "git-remotes",
      status: "fail",
      summary: "git cannot reach gitlab.example.com: no sign-in for HTTPS.",
      fix: "Sign in.",
    };
    const plan = getStartedPlan(report(ok("projects-folder", "/workspaces"), unreachable));
    expect(plan.steps.at(-1)).toMatchObject({ title: "Git access to your repo hosts", need: "recommended", state: "todo" });
    expect(plan.ready).toBe(true);
  });

  test("mise, the sandbox and the repo host CLIs are good to have, never steps, and the folded row names the missing ones", () => {
    const plan = getStartedPlan(FOLDER_NOT_TRUSTED);
    expect(plan.goodToHave.map((g) => [g.title, g.ok])).toEqual([
      ["mise", true],
      ["GitLab CLI (glab)", false],
    ]);
    expect(goodToHaveSummary(plan.goodToHave)).toBe("1 tool could add more: GitLab CLI (glab).");
    expect(goodToHaveSummary(plan.goodToHave.filter((g) => g.ok))).toBe("All there.");
  });

  test("doctor checks that are neither steps nor tools are counted for the link to Diagnostics", () => {
    expect(getStartedPlan(FOLDER_NOT_TRUSTED).otherProblems).toBe(1);
    expect(getStartedPlan(NEW_COMPUTER).otherProblems).toBe(0);
  });

  test("Trackwall says where it runs from what the daemon knows, without asking", () => {
    expect(getStartedPlace({ container: null })).toBe("on this computer");
    expect(getStartedPlace({ container: "3f".repeat(32) })).toBe("in a container");
  });

  test("a fix that names one command offers it to copy; a program's name alone, several commands or none do not", () => {
    expect(fixCommand("Run `gh auth login --hostname github.com` in a terminal.")).toBe("gh auth login --hostname github.com");
    expect(fixCommand("Install GitHub Copilot CLI, sign in by running `copilot` once, and restart Trackwall.")).toBeNull();
    expect(fixCommand("Run `git config --global user.name` and `git config --global user.email`.")).toBeNull();
    expect(fixCommand("Install mise (mise.jdx.dev) and restart Trackwall.")).toBeNull();
    expect(fixCommand(null)).toBeNull();
  });
});

describe("Get started above the Sessions form", () => {
  test("shows while no projects folder is set, whatever else is known", () => {
    expect(getStartedInSessions(null, 0, null)).toBe(true);
    expect(getStartedInSessions(null, 3, 0)).toBe(true);
  });

  test("with a folder, shows until the first session while the doctor's last run left a step open", () => {
    expect(getStartedInSessions("/home/me/dev", 0, 2)).toBe(true);
    expect(getStartedInSessions("/home/me/dev", 1, 2)).toBe(false);
  });

  test("with a folder, does not run the doctor when its last run left nothing open or it never ran in this browser", () => {
    expect(getStartedInSessions("/home/me/dev", 0, 0)).toBe(false);
    expect(getStartedInSessions("/home/me/dev", 0, null)).toBe(false);
  });

  test("does not show while the workspace settings are on their way and nothing was left open", () => {
    expect(getStartedInSessions(undefined, 0, null)).toBe(false);
    expect(getStartedInSessions(undefined, 0, 1)).toBe(true);
  });

  test("lists the steps not done one by one, in their order, and the done ones in one line", () => {
    const plan = getStartedPlan(NEW_COMPUTER);

    expect(stepsLeft(plan).map((s) => [s.id, s.state])).toEqual([
      ["projects-folder", "todo"],
      ["copilot-cli", "todo"],
      ["copilot-trusted-folder", "later"],
    ]);
    expect(doneStepsLine(plan)).toBe("Done: Git, Network for sessions.");
  });

  test("with every step done nothing is left one by one, and with none done there is no line of done steps", () => {
    const allDone = getStartedPlan(
      report(
        ok("projects-folder", "/home/me/dev"),
        ok("git", "git 2.47.1"),
        ok("copilot-cli", "Copilot CLI 1.0.110"),
        ok("network", "github.com and api.githubcopilot.com answer."),
        ok("copilot-trusted-folder", "Copilot CLI trusts /home/me/dev."),
      ),
    );
    const noneDone = getStartedPlan(
      report({ id: "projects-folder", status: "fail", summary: "No projects folder is set.", fix: "Choose the folder with your repos." }),
    );

    expect(stepsLeft(allDone)).toEqual([]);
    expect(doneStepsLine(allDone)).toBe(
      "Done: Projects folder, Git, Copilot CLI, Network for sessions, Copilot CLI trusts your projects folder.",
    );
    expect(doneStepsLine(noneDone)).toBeNull();
  });
});
