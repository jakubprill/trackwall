/**
 * How much a Copilot CLI session looks around before its first edit, from the session's own event log
 * (`<COPILOT_HOME>/session-state/<id>/events.jsonl`), which Copilot CLI keeps after the session ends, unlike the daemon's
 * `hooks.jsonl`. The numbers decide whether a repo map tool for agents is worth building (`scripts/exploration-cost.ts`).
 * The log is Copilot CLI's undocumented format, so every line is parsed on its own and a line of another shape is skipped.
 * Nothing of a prompt, a command or a tool result leaves this file: only tool names, counts, times and tokens.
 */
import { MCP_SERVER_NAME } from "@trackwall/protocol";
import { z } from "zod";

/**
 * Tools that change files: the first call of one ends the look around. `edit`, `create` and `apply_patch` were seen in
 * Copilot CLI 1.0.103; an edit through the shell without a redirection (`sed -i`, `git apply`, a generator) counts as
 * another call, so for such a session the look around runs on past its real first edit.
 */
const EDIT_TOOLS = new Set(["edit", "create", "apply_patch"]);
/** Tools that only read the code, by Copilot CLI's names for its built-in tools. */
const READ_TOOLS = new Set(["view", "grep", "glob", "lsp"]);
/** Shell tools; a command counts as reading when every program it runs only reads (`shellCommandReads`). */
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Copilot CLI's own bookkeeping, not work on the code. */
const META_TOOLS = new Set(["report_intent", "update_todo", "think", "task_complete"]);
/** A sub-agent Copilot CLI starts, often to explore. */
const SUBAGENT_TOOL = "task";
/** Copilot CLI names an MCP tool `<server>-<tool>` (seen in 1.0.103), so Trackwall's tools carry this prefix. */
const TRACKWALL_TOOL_PREFIX = `${MCP_SERVER_NAME}-`;

/** Programs that only read files or the repo. */
const READING_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "ls",
  "dir",
  "tree",
  "find",
  "grep",
  "rg",
  "ag",
  "wc",
  "pwd",
  "cd",
  "type",
  "findstr",
  "get-content",
  "gc",
  "get-childitem",
  "gci",
  "select-string",
  "sls",
  "set-location",
]);
/** git subcommands that only read. */
const READING_GIT = new Set(["log", "show", "grep", "ls-files", "ls-tree", "diff", "status", "blame"]);
/** `find` options that change files. */
const WRITING_FIND = /\s-(exec|execdir|ok|delete)\b/;

export type ToolKind = "edit" | "read" | "trackwall" | "subagent" | "other" | "meta";

/** Whether every program a shell command runs only reads: each part between `&&`, `||`, `;`, `|` and line breaks is checked. */
export function shellCommandReads(command: string): boolean {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const [program = "", subcommand = ""] = part.split(/\s+/);
    const name = program.toLowerCase();
    if (name === "git") return READING_GIT.has(subcommand.toLowerCase());
    if (name === "find") return !WRITING_FIND.test(part);
    return READING_PROGRAMS.has(name);
  });
}

const ShellArguments = z.object({ command: z.string() });
const ShellInfo = z.object({ hasWriteFileRedirection: z.boolean() });

/** What a tool call is, from its name and, for a shell, its command. */
export function toolKind(name: string, args: unknown, shellInfo: unknown): ToolKind {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (READ_TOOLS.has(name)) return "read";
  if (META_TOOLS.has(name)) return "meta";
  if (name === SUBAGENT_TOOL) return "subagent";
  if (name.startsWith(TRACKWALL_TOOL_PREFIX)) return "trackwall";
  if (SHELL_TOOLS.has(name)) {
    if (ShellInfo.safeParse(shellInfo).data?.hasWriteFileRedirection === true) return "edit";
    const command = ShellArguments.safeParse(args).data?.command;
    return command !== undefined && shellCommandReads(command) ? "read" : "other";
  }
  return "other";
}

/** What the output may name: a tool of another MCP server becomes `other MCP`, since the server's name may be the user's company's. */
export function sharedToolName(name: string): string {
  return name.includes("-") && !name.startsWith(TRACKWALL_TOOL_PREFIX) ? OTHER_MCP_TOOL : name;
}
const OTHER_MCP_TOOL = "other MCP";

const SessionEvent = z.object({ type: z.string(), timestamp: z.string(), data: z.unknown().optional() });
type SessionEvent = z.infer<typeof SessionEvent>;
const ToolStart = z.object({ toolName: z.string(), arguments: z.unknown().optional(), shellToolInfo: z.unknown().optional() });
const UsageRecord = z.object({ usage: z.object({ inputTokens: z.number() }) });

/** The look around of one session: from its first prompt up to its first edit, or to its end when it never edits. */
export interface Exploration {
  startedAt: string;
  /** Whether the session edited a file at all; without an edit the counts cover the whole session. */
  edited: boolean;
  calls: Record<Exclude<ToolKind, "edit" | "meta">, number>;
  /** Tool calls by name before the first edit, so names the kinds do not know show (`sharedToolName`). */
  tools: Record<string, number>;
  /** Model turns before the first edit. */
  turns: number;
  /** Input tokens of those turns: the context the look around cost. */
  inputTokens: number;
  /** Seconds from the first prompt to the first edit (or the last event). */
  seconds: number;
}

/** The look around in the lines of a session's `events.jsonl`; `undefined` when the session never got a prompt. */
export function measureExploration(lines: readonly string[]): Exploration | undefined {
  const events = lines.map(parseEvent).filter((event) => event !== undefined);
  const first = events.findIndex((event) => event.type === "user.message");
  const prompt = events[first];
  if (first === -1 || prompt === undefined) return undefined;
  const found: Exploration = {
    startedAt: prompt.timestamp,
    edited: false,
    calls: { read: 0, trackwall: 0, subagent: 0, other: 0 },
    tools: {},
    turns: 0,
    inputTokens: 0,
    seconds: 0,
  };
  const startMs = Date.parse(prompt.timestamp);
  for (const event of events.slice(first + 1)) {
    found.seconds = Math.max(0, Math.round((Date.parse(event.timestamp) - startMs) / 1000));
    if (count(found, event) === "edit") {
      found.edited = true;
      break;
    }
  }
  return found;
}

/** Adds one event to the counts; `"edit"` for the first edit, where counting stops. */
function count(found: Exploration, event: SessionEvent): "edit" | undefined {
  if (event.type === "assistant.turn_start") found.turns += 1;
  if (event.type === "session.usage_record") found.inputTokens += UsageRecord.safeParse(event.data).data?.usage.inputTokens ?? 0;
  if (event.type !== "tool.execution_start") return undefined;
  const tool = ToolStart.safeParse(event.data).data;
  if (tool === undefined) return undefined;
  const kind = toolKind(tool.toolName, tool.arguments, tool.shellToolInfo);
  if (kind === "edit") return "edit";
  if (kind === "meta") return undefined;
  found.calls[kind] += 1;
  const name = sharedToolName(tool.toolName);
  found.tools[name] = (found.tools[name] ?? 0) + 1;
  return undefined;
}

function parseEvent(line: string): SessionEvent | undefined {
  if (line.trim() === "") return undefined;
  try {
    return SessionEvent.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

/** The median, the 75th percentile and the largest of some numbers (all 0 for none). */
export function spread(values: readonly number[]): { median: number; p75: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return { median: at(0.5), p75: at(0.75), max: sorted.at(-1) ?? 0 };
}
