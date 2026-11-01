import { countLabel, type Session, type SessionList, type Task } from "@trackwall/protocol";
import type { AwayPeriod } from "./away-presence.ts";
import type { StatusTone } from "./repo-status.ts";
import { latestSession, proposalName, type SessionSelection, taskName } from "./session-entries.ts";
import { PROPOSAL_STATUS, sessionStateLabel, sessionTitle } from "./session-state.ts";

/**
 * "While you were away" (ADR-151): what changed in the session list since the user's absence began, read from the list
 * itself, so it shows the work as it is now rather than every step on the way: a proposal that came, a session that
 * waits for you, ended or failed, a task that reported its result, and every session that may be stuck now. One
 * item per proposal, task (with its newest session) or session; what needs the user comes first, then the newest.
 */

interface AwayFact {
  tone?: StatusTone;
  text: string;
}

export interface AwayItem {
  /** React key: the proposal, task or session id. */
  key: string;
  title: string;
  facts: readonly [AwayFact, ...AwayFact[]];
  /** When the newest of its facts happened, ISO 8601. */
  at: string;
  open: SessionSelection;
}

/** A result's first line is enough to tell the tasks apart; the task panel has the rest. */
const RESULT_MAX_CHARS = 120;

export function awaySummary(list: SessionList, away: AwayPeriod, now: Date): AwayItem[] {
  const from = Date.parse(away.from);
  const since = (iso: string | undefined) => iso !== undefined && Date.parse(iso) >= from;
  const proposals: AwayItem[] = list.proposals
    .filter((p) => since(p.createdAt))
    .map((p) => ({
      key: p.id,
      title: proposalName(p),
      facts: [{ tone: PROPOSAL_STATUS.tone, text: PROPOSAL_STATUS.label }],
      at: p.createdAt,
      open: { kind: "proposal", id: p.id },
    }));
  const tasks = list.tasks.map((task) => taskItem(task, latestSession(list.sessions, task.id), since, now));
  // A task's sessions are its item; the supervisor is listed, and opening it opens its panel.
  const sessions = list.sessions.filter((s) => s.task === null).map((s) => sessionItem(s, since, now));
  const items = [...proposals, ...tasks, ...sessions].filter((item) => item !== undefined);
  return items.sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || Date.parse(b.at) - Date.parse(a.at));
}

type Since = (iso: string | undefined) => boolean;

function taskItem(task: Task, session: Session | undefined, since: Since, now: Date): AwayItem | undefined {
  const state = session && sessionFact(session, since, now);
  const reported = task.summary !== null && since(task.summary.reportedAt) ? task.summary : undefined;
  const facts = [...(state ? [state.fact] : []), ...(reported ? [{ text: `reported a result: ${firstLine(reported.text)}` }] : [])];
  const [first, ...rest] = facts;
  if (first === undefined) return undefined;
  const times = [state?.at, reported?.reportedAt].filter((t) => t !== undefined);
  return {
    key: task.id,
    title: `${task.repo} · ${taskName(task)}`,
    facts: [first, ...rest],
    at: newest(times),
    open: { kind: "task", id: task.id },
  };
}

function sessionItem(session: Session, since: Since, now: Date): AwayItem | undefined {
  const state = sessionFact(session, since, now);
  if (state === undefined) return undefined;
  return { key: session.id, title: sessionTitle(session), facts: [state.fact], at: state.at, open: { kind: "session", id: session.id } };
}

/**
 * What the session did while the user was away: it may be stuck now (whenever it began), or its state changed in the
 * absence to one that needs a look: waiting for you, an error, no response, or its end. An end the user caused is no news,
 * and neither is work that simply goes on.
 */
function sessionFact(session: Session, since: Since, now: Date): { fact: AwayFact; at: string } | undefined {
  const { run, state } = session;
  const { tone, label } = sessionStateLabel(session);
  if (session.stuck !== null) {
    const minutes = Math.floor((now.getTime() - Date.parse(session.stuck.lastStepAt)) / 60_000);
    return { fact: { tone, text: `${label}: no step for ${minutes} min` }, at: session.stuck.lastStepAt };
  }
  const fact = { tone, text: label };
  if (run.kind === "exited") return run.stoppedByUser || !since(run.endedAt) ? undefined : { fact, at: run.endedAt };
  if (state === null || !since(state.at)) return undefined;
  return session.needsAttention || tone === "error" ? { fact, at: state.at } : undefined;
}

function needsYou(item: AwayItem): boolean {
  return item.facts.some((f) => f.tone === "warning" || f.tone === "error");
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > RESULT_MAX_CHARS ? `${line.slice(0, RESULT_MAX_CHARS - 1)}…` : line;
}

function newest(times: readonly string[]): string {
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** The strip's line: how long the absence was and how much of the summary needs the user. */
export function awayHeadline(items: readonly AwayItem[], away: AwayPeriod): string {
  const changes = countLabel(items.length, { one: "change", other: "changes" });
  const waiting = items.filter(needsYou).length;
  const needs = waiting === 0 ? "" : `, ${waiting} ${waiting === 1 ? "needs" : "need"} you`;
  return `While you were away (${awayLength(away)}): ${changes}${needs}`;
}

/** Whole minutes, and hours above an hour: an absence is at least `AWAY_AFTER_MS` long. */
function awayLength({ from, to }: AwayPeriod): string {
  const minutes = Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

/**
 * An absence with nothing to show once the list has come is closed at once: kept, it would make the next absence start
 * there, days back. Before the list comes, nothing is known yet.
 */
export function absenceToClose(list: SessionList | undefined, away: AwayPeriod | undefined, items: readonly AwayItem[]): boolean {
  return list !== undefined && away !== undefined && items.length === 0;
}
