import { countLabel, type DoctorCheck, type DoctorCheckId, type DoctorReport } from "@trackwall/protocol";
import type { DaemonPlace } from "./desktop.ts";
import { doctorCheckTitle } from "./doctor.ts";

/**
 * "Get started" (ADR-262): the few doctor checks (ADR-101) that stand between a new user and a first session, as a list
 * of steps in the order to do them. It adds no checks of its own: every step is a doctor check read another way, so the
 * list and "Settings > Diagnostics" never disagree. Everything else in Settings has a default that works.
 */

/** `needed` stops a first session while it is open; `recommended` only makes every session ask or fail later. */
type GetStartedNeed = "needed" | "recommended";

/**
 * `done`: the check is ok, or works with a gap its summary names. `todo`: the user has something to do. `later`: the
 * check did not run because an earlier step is open (Copilot CLI's trusted folder needs the projects folder).
 */
type GetStartedState = "done" | "todo" | "later";

export interface GetStartedStep {
  id: DoctorCheckId;
  title: string;
  need: GetStartedNeed;
  state: GetStartedState;
  /** What the doctor found, or why the step waits. */
  summary: string;
  /** What to do, for a step that is `todo`; `null` otherwise. */
  fix: string | null;
}

/** A tool that is not needed to start, with what it adds, shown folded under the steps. */
export interface GoodToHave {
  id: DoctorCheckId;
  title: string;
  ok: boolean;
  summary: string;
  fix: string | null;
}

export interface GetStartedPlan {
  steps: GetStartedStep[];
  goodToHave: GoodToHave[];
  /** No `needed` step is open: a session can start. */
  ready: boolean;
  /** The `needed` steps that are `todo`. */
  neededOpen: number;
  /** The steps that are `todo`, needed and recommended: the number next to the category's name. */
  open: number;
  /** Doctor checks outside this list that are not ok, which "Settings > Diagnostics" shows. */
  otherProblems: number;
}

/** The steps in the order to do them, each with its own wording: the doctor's titles name the check, these name the goal. */
const STEPS: readonly { id: DoctorCheckId; title: string; need: GetStartedNeed; later?: string }[] = [
  { id: "projects-folder", title: "Projects folder", need: "needed" },
  { id: "git", title: "Git", need: "needed" },
  { id: "copilot-cli", title: "Copilot CLI", need: "needed" },
  { id: "network", title: "Network for sessions", need: "needed" },
  {
    id: "copilot-trusted-folder",
    title: "Copilot CLI trusts your projects folder",
    need: "recommended",
    later: "Checked once the projects folder is set.",
  },
  { id: "git-remotes", title: "Git access to your repo hosts", need: "recommended" },
];

/** Tools Trackwall works without, in the order of how much they add. */
const GOOD_TO_HAVE: readonly DoctorCheckId[] = ["mise", "copilot-sandbox", "github-cli", "gitlab-cli"];

function stepState(check: DoctorCheck, need: GetStartedNeed): GetStartedState {
  if (check.status === "ok") return "done";
  // A needed step with a warning works (an older Copilot CLI): it is done, and its summary says what the gap is.
  return need === "needed" && check.status === "warn" ? "done" : "todo";
}

export function getStartedPlan(report: DoctorReport): GetStartedPlan {
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  // A step whose check did not run shows as waiting only while the projects folder, which it waits for, is still open.
  const folderOpen = byId.get("projects-folder")?.status === "fail";
  const steps = STEPS.flatMap(({ id, title, need, later }): GetStartedStep[] => {
    const check = byId.get(id);
    if (check === undefined)
      return later !== undefined && folderOpen ? [{ id, title, need, state: "later", summary: later, fix: null }] : [];
    const state = stepState(check, need);
    return [{ id, title, need, state, summary: check.summary, fix: state === "todo" ? check.fix : null }];
  });
  const goodToHave = GOOD_TO_HAVE.flatMap((id): GoodToHave[] => {
    const check = byId.get(id);
    return check ? [{ id, title: doctorCheckTitle(id), ok: check.status === "ok", summary: check.summary, fix: check.fix }] : [];
  });
  const listed = new Set<DoctorCheckId>([...STEPS.map((s) => s.id), ...GOOD_TO_HAVE]);
  const todo = steps.filter((s) => s.state === "todo");
  const neededOpen = todo.filter((s) => s.need === "needed").length;
  return {
    steps,
    goodToHave,
    ready: neededOpen === 0,
    neededOpen,
    open: todo.length,
    otherProblems: report.checks.filter((c) => !listed.has(c.id) && c.status !== "ok").length,
  };
}

/** The line under the title: how much is left before a first session, or that nothing is. */
export function getStartedHeadline({ neededOpen, open }: Pick<GetStartedPlan, "neededOpen" | "open">): string {
  if (neededOpen > 0) return `${countLabel(neededOpen, { one: "step", other: "steps" })} left before your first session.`;
  if (open > 0) return `Ready. ${countLabel(open, { one: "recommended step is", other: "recommended steps are" })} left.`;
  return "Ready. Everything Trackwall needs to start a session is in place.";
}

/** Where Trackwall runs, which decides what the steps find; Trackwall knows it, so the user is never asked. */
export function getStartedPlace(place: Pick<DaemonPlace, "container">): string {
  return place.container === null ? "on this computer" : "in a container";
}

/** The one line of the folded "Good to have" row: what is there and what is not. */
export function goodToHaveSummary(items: readonly GoodToHave[]): string {
  const missing = items.filter((i) => !i.ok).map((i) => i.title);
  if (missing.length === 0) return "All there.";
  return `${countLabel(missing.length, { one: "tool", other: "tools" })} could add more: ${missing.join(", ")}.`;
}

/**
 * The command a fix asks the user to run, when it names exactly one in backticks ("Run `gh auth login` in a terminal."),
 * so the step can offer it to copy; `null` when it names none or several, where copying one would mislead. One word in
 * backticks is a program's name, not a command to paste.
 */
export function fixCommand(fix: string | null): string | null {
  const commands = [...(fix ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  return commands.length === 1 && commands[0] !== undefined && commands[0].includes(" ") ? commands[0] : null;
}

/** What the entry of "Get started" in the list of Settings categories says under its name (ADR-268), and whether it calls for the user. */
export interface GetStartedEntry {
  text: string;
  state: "unknown" | "to-do" | "done";
}

export function getStartedEntry(open: number | null): GetStartedEntry {
  if (open === null) return { text: "Check your setup", state: "unknown" };
  if (open === 0) return { text: "All set", state: "done" };
  return { text: open === 1 ? "1 step to do" : `${open} steps to do`, state: "to-do" };
}
