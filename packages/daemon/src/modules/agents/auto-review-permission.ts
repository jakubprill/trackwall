import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isInside } from "../../infra/path-inside.ts";
import { type PermissionOutcome, RequestPermissionParams } from "./acp-messages.ts";

/**
 * The daemon's answer to an approval the automatic reviewer asks for (ADR-182, clarification of 2026-11-13): nobody
 * watches the run to decide, so everything is refused except reading the review's own folder (the diff and the rule
 * files' copies the daemon wrote). Copilot CLI asks before every read outside the worktree, and its `--add-dir` does
 * not spare that over ACP, so without this one approval the reviewer could not read its diff at all.
 *
 * A read is approved once (`allow_once`, never "always"), only when every path it names, with its links resolved, lies
 * in the review's folder with its links resolved: `..` and a link out of the folder are refused like any other path.
 */

export interface ReviewPermission {
  /** The request as the review's message names it when refused: its title, with the paths it names. */
  title: string;
  outcome: PermissionOutcome;
  approved: boolean;
}

/** The kind of tool call Copilot CLI asks about for `view`, `grep` and `glob` outside the trusted folders. */
const READ_KIND = "read";

export function reviewPermission(method: string, params: unknown, reviewDir: string): ReviewPermission {
  if (method !== "session/request_permission") throw new Error(`${method} is not offered`);
  const parsed = RequestPermissionParams.safeParse(params);
  if (!parsed.success) return { title: "an approval it could not read", outcome: { outcome: "cancelled" }, approved: false };
  const { toolCall, options } = parsed.data;
  const paths = requestedPaths(toolCall);
  const name = toolCall.title ?? "a tool";
  const title = paths.length === 0 ? name : `${name}: ${paths.join(", ")}`;
  const allowOnce = options.find((option) => option.kind === "allow_once");
  if (toolCall.kind === READ_KIND && allowOnce !== undefined && paths.length > 0 && paths.every((path) => readable(path, reviewDir)))
    return { title, outcome: { outcome: "selected", optionId: allowOnce.optionId }, approved: true };
  const reject = options.find((option) => option.kind.startsWith("reject"));
  return { title, outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" }, approved: false };
}

/** The paths a tool call names: its locations and the `path` of its input, each once. */
function requestedPaths(toolCall: RequestPermissionParams["toolCall"]): string[] {
  const input = toolCall.rawInput;
  const inputPath = typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? [input.path] : [];
  return [...new Set([...(toolCall.locations ?? []).map((location) => location.path), ...inputPath])];
}

/** `path` is the review's folder or in it, as the file system resolves both; a path that does not exist is not. */
function readable(path: string, reviewDir: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return isInside(realpathSync.native(reviewDir), realpathSync.native(path));
  } catch {
    return false;
  }
}
