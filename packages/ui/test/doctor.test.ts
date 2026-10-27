import { describe, expect, test } from "bun:test";
import type { DoctorReport } from "@trackwall/protocol";
import { doctorEntry, doctorHeadline } from "../src/lib/doctor.ts";

const REPORT: DoctorReport = {
  checkedAt: "2026-10-27T20:00:00.000Z",
  checks: [
    { id: "git", status: "ok", summary: "git 2.47.1", fix: null },
    {
      id: "copilot-trusted-folder",
      status: "warn",
      summary: "Copilot CLI does not trust the projects folder; it asks before working in each repo.",
      fix: 'Add /home/me/dev to "trustedFolders" in /home/me/.copilot/config.json, so Copilot CLI stops asking for every repo and task.',
    },
    {
      id: "github-cli",
      status: "fail",
      summary: "gh is not signed in to github.com: not logged in",
      fix: "Run `gh auth login --hostname github.com` in a terminal.",
    },
  ],
};

describe("doctor", () => {
  test("a check shows what it is about, its state, what was found and what to do", () => {
    expect(REPORT.checks.map(doctorEntry)).toEqual([
      { title: "Git", status: "OK", summary: "git 2.47.1", fix: null },
      {
        title: "Copilot CLI trusted folder",
        status: "Check",
        summary: "Copilot CLI does not trust the projects folder; it asks before working in each repo.",
        fix: 'Add /home/me/dev to "trustedFolders" in /home/me/.copilot/config.json, so Copilot CLI stops asking for every repo and task.',
      },
      {
        title: "GitHub CLI (gh)",
        status: "Missing",
        summary: "gh is not signed in to github.com: not logged in",
        fix: "Run `gh auth login --hostname github.com` in a terminal.",
      },
    ]);
  });

  test("the headline counts the checks that are not ok, or says everything is in place", () => {
    expect(doctorHeadline(REPORT)).toBe("2 checks need your attention.");
    expect(doctorHeadline({ ...REPORT, checks: REPORT.checks.slice(0, 2) })).toBe("1 check needs your attention.");
    expect(doctorHeadline({ ...REPORT, checks: REPORT.checks.slice(0, 1) })).toBe("Everything Trackwall needs is in place.");
  });
});
