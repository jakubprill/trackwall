import { countLabel, type DoctorCheckId, type DoctorReport, type DoctorStatus } from "@trackwall/protocol";

/** What each doctor check is about, as Settings names it (ADR-101). */
const CHECK_TITLES: Record<DoctorCheckId, string> = {
  "projects-folder": "Projects folder",
  "projects-folder-storage": "Projects folder storage",
  "workspace-file": "Workspace settings file",
  git: "Git",
  "copilot-cli": "Copilot CLI",
  "copilot-trusted-folder": "Copilot CLI trusted folder",
  mise: "mise",
  "java-navigation": "Java navigation",
  "github-cli": "GitHub CLI (gh)",
  "gitlab-cli": "GitLab CLI (glab)",
};

const STATUS_LABELS: Record<DoctorStatus, string> = { ok: "OK", warn: "Check", fail: "Problem" };

export function doctorCheckTitle(id: DoctorCheckId): string {
  return CHECK_TITLES[id];
}

export function doctorStatusLabel(status: DoctorStatus): string {
  return STATUS_LABELS[status];
}

/** How many checks need something done: the number on the section and in its headline. */
export function doctorProblemCount(report: DoctorReport): number {
  return report.checks.filter((c) => c.status !== "ok").length;
}

/** The line above the list: everything in place, or how many checks need something done. */
export function doctorHeadline(report: DoctorReport): string {
  const problems = doctorProblemCount(report);
  if (problems === 0) return "Everything Trackwall needs is in place.";
  return `${countLabel(problems, { one: "check needs", other: "checks need" })} your attention.`;
}
