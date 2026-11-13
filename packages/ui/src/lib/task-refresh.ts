import { countLabel, type TaskRefresh } from "@trackwall/protocol";

/**
 * What the task's "Refresh from <branch>" (ADR-245) says after it ran: what came in, that nothing was needed, or which
 * files would conflict, with what the user can do about them.
 */
export function refreshMessage(result: TaskRefresh): { tone: "done" | "warning"; text: string } {
  switch (result.state) {
    case "up-to-date":
      return { tone: "done", text: `Already up to date with ${result.from}.` };
    case "refreshed":
      return {
        tone: "done",
        text: `Merged ${countLabel(result.commits, { one: "commit", other: "commits" })} from ${result.from}. The agent is told to read the changed files again.`,
      };
    case "conflicts":
      return {
        tone: "warning",
        text:
          `Not refreshed: merging ${countLabel(result.commits, { one: "commit", other: "commits" })} from ${result.from} would conflict in ` +
          `${result.files.join(", ")}. Nothing was changed; you can ask the agent to merge ${result.from} and resolve the conflicts.`,
      };
  }
}
