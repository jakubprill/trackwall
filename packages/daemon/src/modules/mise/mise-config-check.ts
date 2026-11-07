import { relative, resolve } from "node:path";
import type { MiseConfigProblem } from "@trackwall/protocol";
import { z } from "zod";
import { isInside } from "../../infra/path-inside.ts";
import { type MiseCliResult, miseFailure } from "./mise-cli.ts";

/**
 * Reading what mise says about a repo root's own config files (§4.7, §4.26): `mise fmt --check`, which names the files its
 * formatter would rewrite, and `mise tasks validate --json`, which checks the task definitions, with the warnings mise prints
 * on stderr for fields it does not know. mise is the only judge of its format and fields, so nothing here parses TOML. Only
 * an answer of a mise that ran is read: one that did not start or finish is `null`, a failure of mise, not of the config.
 */

/** The line `mise fmt --check` prints before the files it would rewrite, one full path per line. */
const UNFORMATTED_HEADER = /Following config files are not properly formatted:/;
/**
 * What an older mise says for a command or flag it does not have yet (clap's words): such a mise cannot check, which is not
 * a problem of the repo's config.
 */
const UNSUPPORTED = /unrecognized subcommand|unexpected argument/i;
/**
 * What `mise fmt --check` says in a repo without a config of its own, whose mise tasks come only from the projects folder's
 * config (the convention tasks): nothing of the repo to format, which is not a problem of its config.
 */
const NO_CONFIG = /No config file found in current directory/;
/** mise's warning for a field it does not know: `mise WARN  unknown field in /r/mise.toml:4:2: taskz (did you mean tasks?)`. */
const UNKNOWN_FIELD = /^mise WARN\s+unknown field in (.+):(\d+):(\d+): (.+)$/;

/**
 * The repo root as mise may print it: mise names files under the directory as the system resolves it (macOS's `/var` is
 * `/private/var`, a projects folder behind a link), so a check takes the root both as given and resolved.
 */
export type RepoRoots = readonly string[];

/** `file` relative to the repo root it lies in, or `null` for a file outside the repo (the projects folder's, the global). */
function inRepo(roots: RepoRoots, file: string): string | null {
  // mise prints full paths today; a relative one would be relative to the repo root it ran in.
  const path = resolve(roots[0] ?? "", file);
  const root = roots.find((r) => isInside(r, path));
  return root === undefined ? null : relative(root, path);
}

export interface FormatCheck {
  unformatted: string[];
  problems: MiseConfigProblem[];
}

/** The repo's files `mise fmt --check` would rewrite, relative to its root, or the problem that stopped it. */
export function parseFormatCheck(result: MiseCliResult, roots: RepoRoots): FormatCheck | null {
  if (result.kind !== "exited") return null;
  if (result.code === 0 || UNSUPPORTED.test(result.stderr) || NO_CONFIG.test(result.stderr)) return { unformatted: [], problems: [] };
  const lines = result.stderr.split(/\r?\n/).map((l) => l.trim());
  const header = lines.findIndex((l) => UNFORMATTED_HEADER.test(l));
  if (header === -1)
    return { unformatted: [], problems: [{ severity: "error", message: firstLine(miseFailure(result.stderr, result.code)) }] };
  const files = lines.slice(header + 1).filter((l) => l !== "" && !l.startsWith("mise "));
  return { unformatted: files.flatMap((file) => inRepo(roots, file) ?? []), problems: [] };
}

const ValidationIssue = z.object({
  task: z.string(),
  severity: z.string(),
  message: z.string(),
  /** What the message refers to (`task not found: nope`), which some messages need to make sense. */
  details: z.string().nullish(),
});
const Validation = z.object({ issues: z.array(ValidationIssue) });

/**
 * The problems `mise tasks validate --json` found, errors first: each task's issues as mise words them, and the fields of the
 * repo's own files mise does not know, which it only warns about (a typo such as `taskz` or `rn` leaves part of the config
 * unread).
 */
export function parseValidation(result: MiseCliResult, roots: RepoRoots): MiseConfigProblem[] | null {
  if (result.kind !== "exited") return null;
  if (UNSUPPORTED.test(result.stderr)) return [];
  const unknown = unknownFields(result.stderr, roots);
  const issues = validationIssues(result.stdout);
  if (issues === null) {
    // Exit 0 without the JSON is a mise that printed nothing to check; any other exit is mise's own error.
    if (result.code === 0) return unknown;
    return [{ severity: "error", message: firstLine(miseFailure(result.stderr, result.code)) }, ...unknown];
  }
  const all = [...issues, ...unknown];
  return [...all.filter((p) => p.severity === "error"), ...all.filter((p) => p.severity === "warning")];
}

function validationIssues(stdout: string): MiseConfigProblem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = Validation.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.issues.map((i) => ({
    severity: i.severity === "error" ? "error" : "warning",
    message: i.details ? `${i.task}: ${i.message}: ${i.details}` : `${i.task}: ${i.message}`,
  }));
}

/** The repo's own unknown fields, one line per field and place, since mise may print a warning twice. */
function unknownFields(stderr: string, roots: RepoRoots): MiseConfigProblem[] {
  const seen = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    const match = UNKNOWN_FIELD.exec(line.trim());
    if (match === null) continue;
    const [, file = "", row, column, what] = match;
    const where = inRepo(roots, file);
    if (where !== null) seen.add(`${where}:${row}:${column}: unknown field ${what}`);
  }
  return [...seen].map((message) => ({ severity: "warning", message }));
}

/**
 * mise's errors can run over many lines (a TOML excerpt); a problem is one line without mise's prefix, and the mise tasks
 * tab has the rest.
 */
function firstLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? "").replace(/^mise ERROR\s+/, "");
}
