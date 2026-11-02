import { relative } from "node:path";
import {
  CONVERSATION_TEXT_MAX,
  type ConversationEntry,
  TOOL_FILE_PATH_MAX,
  TOOL_FILES_MAX,
  TOOL_KIND_MAX,
  TOOL_PATCH_MAX,
} from "@trackwall/protocol";
import { isInside } from "../../infra/path-inside.ts";
import { contentText, type SessionUpdate, type ToolCallContent } from "./acp-messages.ts";

/**
 * What the conversation view shows of a tool call or its approval (ADR-107), read from ACP's tool call fields as
 * Copilot CLI sends them (`contract/acp-session.contract.ts`): the files it works on, its lines (output, the command, why
 * it failed), the change it makes to files as one unified diff and the subagent it starts, each cut to what a view can hold.
 */

type ToolCall = Pick<
  Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  "content" | "locations" | "rawInput" | "rawOutput" | "status"
>;

/** The most lines of a tool call's detail kept; a long output is cut at the end. */
const DETAIL_LINES_MAX = 400;
/** The most characters of a tool call's detail kept. */
const DETAIL_CHARS_MAX = 64 * 1024;

/** The files a tool call works on, once each, relative to the session's working directory when inside it. */
export function toolCallFiles(toolCall: Pick<ToolCall, "locations">, cwd: string): string[] {
  const paths = (toolCall.locations ?? []).map(({ path }) => (path !== cwd && isInside(cwd, path) ? relative(cwd, path) : path));
  return [...new Set(paths)].slice(0, TOOL_FILES_MAX).map((path) => path.slice(0, TOOL_FILE_PATH_MAX));
}

/** What a tool call does or did, as lines, cut at 400 lines and 64 Ki characters: its text, the command it runs, or why it failed. */
export function toolCallLines(toolCall: Pick<ToolCall, "content" | "rawInput" | "rawOutput" | "status">): string[] {
  const lines = [
    ...(toolCall.content ?? []).flatMap(textLines),
    ...commandLines(toolCall.rawInput),
    ...(toolCall.status === "failed" ? failureLines(toolCall.rawOutput) : []),
  ];
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, DETAIL_LINES_MAX)) {
    if (chars + line.length > DETAIL_CHARS_MAX) {
      kept.push(line.slice(0, DETAIL_CHARS_MAX - chars));
      break;
    }
    kept.push(line);
    chars += line.length;
  }
  return kept;
}

/**
 * The change a tool call makes to files, as a unified diff, empty when it changes none. Copilot CLI sends the whole
 * hunk with its context as `git diff` text, in `rawOutput.detailedContent` once a tool ran and in `rawInput.diff` when it
 * asks for an approval; its `diff` content holds only the replaced and the new text, which is the last resort.
 */
export function toolCallPatch(toolCall: Pick<ToolCall, "content" | "rawInput" | "rawOutput">): { patch: string; cut: boolean } {
  const patch =
    unifiedDiff(stringField(toolCall.rawOutput, "detailedContent")) ??
    unifiedDiff(stringField(toolCall.rawInput, "diff")) ??
    (toolCall.content ?? []).map(contentPatch).join("");
  if (patch.length <= TOOL_PATCH_MAX) return { patch, cut: false };
  // Cut on a line, so the last line shown is a whole one; a first line longer than the limit is cut inside.
  const lastLine = patch.lastIndexOf("\n", TOOL_PATCH_MAX - 1);
  return { patch: patch.slice(0, lastLine >= 0 ? lastLine + 1 : TOOL_PATCH_MAX), cut: true };
}

/**
 * The subagent a tool call starts: Copilot CLI's `task` tool sends the subagent's type and what it asks it in its input
 * (`agent_type`, `prompt`); `null` for another tool.
 */
export function toolCallSubagent(toolCall: Pick<ToolCall, "rawInput">): Extract<ConversationEntry, { kind: "tool" }>["subagent"] {
  const type = stringField(toolCall.rawInput, "agent_type");
  const prompt = stringField(toolCall.rawInput, "prompt");
  if (type === undefined || prompt === undefined) return null;
  return { type: type.slice(0, TOOL_KIND_MAX), prompt: prompt.slice(0, CONVERSATION_TEXT_MAX) };
}

/** The text when it is a unified diff, without the empty lines Copilot CLI puts before it. */
function unifiedDiff(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const patch = text.replace(/^\n+/, "");
  return /^(diff --git |--- )/.test(patch) && /^@@/m.test(patch) ? patch : undefined;
}

/** A `diff` content as a hunk without line numbers, which Copilot CLI does not send there. */
function contentPatch(content: ToolCallContent): string {
  if (content.type !== "diff" || !("path" in content) || !("newText" in content)) return "";
  const lines = (text: string | null | undefined, sign: string) =>
    (text ?? "")
      .split("\n")
      .filter((line, i, all) => i < all.length - 1 || line !== "")
      .map((line) => `${sign}${line}\n`)
      .join("");
  // Like Copilot CLI's own diffs: an absolute path after `a/` without its leading slash.
  const path = content.path.replace(/^[\\/]+/, "");
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  return `${header}@@ @@\n${lines(content.oldText, "-")}${lines(content.newText, "+")}`;
}

function textLines(content: ToolCallContent): string[] {
  if (content.type !== "content" || !("content" in content)) return [];
  const text = contentText(content.content);
  return text === undefined ? [] : text.split("\n");
}

/** A shell tool's command (`rawInput.command`), the one input the user needs to see before allowing it. */
function commandLines(rawInput: unknown): string[] {
  const command = stringField(rawInput, "command");
  return command === undefined ? [] : [`$ ${command}`];
}

function failureLines(rawOutput: unknown): string[] {
  return stringField(rawOutput, "message")?.split("\n") ?? [];
}

/** A text field of a tool's raw input or output, which ACP leaves to the agent, so its shape is checked here. */
function stringField(raw: unknown, field: string): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value: unknown = Reflect.get(raw, field);
  return typeof value === "string" ? value : undefined;
}
