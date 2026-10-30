/**
 * How much Copilot CLI sessions look around in the code before their first edit: tool calls that only read, model turns,
 * input tokens and time, per session and as median, 75th percentile and maximum. It reads the event logs Copilot CLI
 * keeps in `<COPILOT_HOME>/session-state` (by default `~/.copilot`), by default only of Trackwall's agent tasks (a
 * `trackwall/` branch), and prints only counts, never a prompt, a command, a repo or a path, so the output can be shared.
 * The numbers decide whether a repo map tool for agents is worth building (`docs/development.md`).
 *
 *   bun packages/daemon/scripts/exploration-cost.ts [--all] [--since 2026-10-01] [--copilot-home <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { TASK_BRANCH_PREFIX } from "../src/modules/agents/task-branch.ts";
import { copilotHome } from "../src/modules/doctor/copilot-trust.ts";
import { type Exploration, measureExploration, spread } from "./exploration/measure.ts";

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    since: { type: "string" },
    "copilot-home": { type: "string" },
  },
});
const since = values.since === undefined ? 0 : Date.parse(values.since);
if (Number.isNaN(since)) throw new Error(`--since "${values.since}" is not a date such as 2026-10-01`);
const stateDir = join(values["copilot-home"] ?? copilotHome(process.env), "session-state");
if (!existsSync(stateDir)) throw new Error(`no Copilot CLI sessions in ${stateDir}; name the folder with --copilot-home`);

/** The part of a session's `workspace.yaml` that tells a Trackwall task. */
const SessionWorkspace = z.object({ branch: z.string().optional() });

function isTask(dir: string): boolean {
  const file = join(dir, "workspace.yaml");
  if (!existsSync(file)) return false;
  try {
    return SessionWorkspace.safeParse(parseYaml(readFileSync(file, "utf8"))).data?.branch?.startsWith(TASK_BRANCH_PREFIX) ?? false;
  } catch {
    // Copilot CLI's file, in a format nobody documents: a broken one is not a task, and the run goes on.
    return false;
  }
}

const sessions: Exploration[] = [];
for (const id of readdirSync(stateDir)) {
  const dir = join(stateDir, id);
  const events = join(dir, "events.jsonl");
  if (!existsSync(events) || (!values.all && !isTask(dir))) continue;
  const found = measureExploration(readFileSync(events, "utf8").split("\n"));
  if (found !== undefined && Date.parse(found.startedAt) >= since) sessions.push(found);
}
sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const kind = values.all ? "sessions" : "agent tasks";
if (sessions.length === 0) {
  process.stdout.write(`No ${kind} with a prompt in ${stateDir}.\n`);
  process.exit(0);
}

process.stdout.write(`${sessions.length} ${kind} from ${stateDir}\n\n`);
process.stdout.write("started (UTC)     reads  trackwall  sub-agents  other  turns  input tokens    time  \n");
for (const s of sessions) {
  const cells = [
    s.startedAt.slice(0, 16).replace("T", " "),
    String(s.calls.read).padStart(6),
    String(s.calls.trackwall).padStart(10),
    String(s.calls.subagent).padStart(11),
    String(s.calls.other).padStart(6),
    String(s.turns).padStart(6),
    String(s.inputTokens).padStart(13),
    duration(s.seconds).padStart(7),
    s.edited ? "" : "  no edit",
  ];
  process.stdout.write(`${cells.join(" ")}\n`);
}

const edited = sessions.filter((s) => s.edited);
process.stdout.write(`\nBefore the first edit, in the ${edited.length} that edited (median / 75th percentile / max):\n`);
const line = (label: string, numbers: number[], show: (n: number) => string = String) => {
  const { median, p75, max } = spread(numbers);
  process.stdout.write(`  ${label.padEnd(26)} ${show(median)} / ${show(p75)} / ${show(max)}\n`);
};
line(
  "reading tool calls",
  edited.map((s) => s.calls.read),
);
line(
  "Trackwall tool calls",
  edited.map((s) => s.calls.trackwall),
);
line(
  "sub-agents",
  edited.map((s) => s.calls.subagent),
);
line(
  "model turns",
  edited.map((s) => s.turns),
);
line(
  "input tokens",
  edited.map((s) => s.inputTokens),
);
line(
  "time",
  edited.map((s) => s.seconds),
  duration,
);

const tools = new Map<string, number>();
for (const s of edited) for (const [name, count] of Object.entries(s.tools)) tools.set(name, (tools.get(name) ?? 0) + count);
const top = [...tools].sort((a, b) => b[1] - a[1]).slice(0, 12);
process.stdout.write(`\nTools before the first edit: ${top.map(([name, count]) => `${name} ${count}`).join(", ") || "none"}\n`);

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
