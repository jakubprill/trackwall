import type { ToolPermissionRules, ToolPermissions } from "@trackwall/protocol";
import { globMatcher } from "../../infra/glob.ts";

/**
 * The tool permissions of one session from the `toolPermissions` rules in `workspace.yaml` (ADR-66): the patterns of
 * every rule that applies to the session's repo, in file order and without repeats. A rule without `repos` applies to
 * every session; one with `repos` only to a session in a repo whose identifier one of them matches, so never to the
 * supervisor, which runs above all repos (`repo` is `null`).
 */
export function sessionToolPermissions(rules: ToolPermissionRules, repo: string | null): ToolPermissions {
  const applies = rules.filter(
    (rule) => rule.repos === undefined || (repo !== null && rule.repos.some((p) => globMatcher(p, { ignoreCase: true })(repo))),
  );
  return {
    allow: [...new Set(applies.flatMap((rule) => rule.allow))],
    deny: [...new Set(applies.flatMap((rule) => rule.deny))],
  };
}
