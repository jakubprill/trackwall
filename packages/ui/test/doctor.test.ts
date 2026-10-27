import { describe, expect, test } from "bun:test";
import type { DoctorReport } from "@trackwall/protocol";
import { doctorCheckTitle, doctorHeadline, doctorProblemCount, doctorStatusLabel } from "../src/lib/doctor.ts";

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
  test("a check is named by what it is about and its state", () => {
    expect(REPORT.checks.map((c) => [doctorCheckTitle(c.id), doctorStatusLabel(c.status)])).toEqual([
      ["Git", "OK"],
      ["Copilot CLI trusted folder", "Check"],
      ["GitHub CLI (gh)", "Problem"],
    ]);
  });

  test("the checks that are not ok are counted, and the headline says how many or that everything is in place", () => {
    expect(doctorProblemCount(REPORT)).toBe(2);
    expect(doctorHeadline(REPORT)).toBe("2 checks need your attention.");
    expect(doctorHeadline({ ...REPORT, checks: REPORT.checks.slice(0, 2) })).toBe("1 check needs your attention.");
    expect(doctorProblemCount({ ...REPORT, checks: REPORT.checks.slice(0, 1) })).toBe(0);
    expect(doctorHeadline({ ...REPORT, checks: REPORT.checks.slice(0, 1) })).toBe("Everything Trackwall needs is in place.");
  });
});
