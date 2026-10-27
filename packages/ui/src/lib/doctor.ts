import { countLabel, type DoctorCheckId, type DoctorReport, type DoctorStatus } from "@trackwall/protocol";

/** What each doctor check is about, as Settings names it (ADR-101). */
const CHECK_TITLES: Record<DoctorCheckId, string> = {
  "projects-folder": "Projects folder",
  git: "Git",
  "copilot-cli": "Copilot CLI",
  "copilot-trusted-folder": "Copilot CLI trusted folder",
  mise: "mise",
  "github-cli": "GitHub CLI (gh)",
  "gitlab-cli": "GitLab CLI (glab)",
};

const STATUS_LABELS: Record<DoctorStatus, string> = { ok: "OK", warn: "Check", fail: "Missing" };

/** One check as the doctor's list shows it. */
export function doctorEntry(check: DoctorReport["checks"][number]) {
  return { title: CHECK_TITLES[check.id], status: STATUS_LABELS[check.status], summary: check.summary, fix: check.fix };
}

/** The line above the list: everything in place, or how many checks need something done. */
export function doctorHeadline(report: DoctorReport): string {
  const problems = report.checks.filter((c) => c.status !== "ok").length;
  if (problems === 0) return "Everything Trackwall needs is in place.";
  return `${countLabel(problems, { one: "check needs", other: "checks need" })} your attention.`;
}
