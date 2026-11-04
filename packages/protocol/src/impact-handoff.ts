import { TASK_PROMPT_MAX, TASK_TITLE_MAX, type Task } from "./agents.ts";
import { cutText } from "./cut-text.ts";
import type { ChangedEndpoint, ChangedEndpoints, ImpactedRepo } from "./graph.ts";
import { mcpTools } from "./mcp.ts";

/**
 * What a task handed on to a repo its change reaches is told (ADR-147, ADR-198): the prompt of a hand-off from the
 * Impact tab and of an impact proposal the daemon makes when the task's turn ends, built from the comparison of the
 * task's cards (`get_changed_endpoints`). In `protocol`, because the UI and the daemon build the same prompt.
 */

/** How a hand-off prompt names the handing task: its title, or the first line of its prompt cut like a title. */
export function handingTaskName(task: Pick<Task, "title" | "prompt">): string {
  return task.title ?? cutText(task.prompt.trim().split(/\r?\n/, 1)[0] ?? "", TASK_TITLE_MAX);
}

/** The changed endpoints a repo of ring 1 calls, each with that repo's calls of it. */
export function endpointsCalledBy(endpoints: readonly ChangedEndpoint[], repo: string): ChangedEndpoint[] {
  return endpoints.flatMap((e) => {
    const callers = e.callers.filter((c) => c.repo === repo);
    return callers.length === 0 ? [] : [{ ...e, callers }];
  });
}

/**
 * The prompt of a task handed on to a reached repo, for the user to edit before the start: the endpoints and calls
 * from the daemon's comparison, and the tools that read the handing task's change (the new task's instructions name it).
 * It fits a task's prompt: endpoints past `TASK_PROMPT_MAX` are counted, not listed.
 */
export function handoffPrompt(changed: Pick<ChangedEndpoints, "repo" | "endpoints">, taskName: string, reached: ImpactedRepo): string {
  const from = `the task “${taskName}” in ${changed.repo}`;
  const read = `Read that task's change with ${mcpTools.getChangedEndpoints.name} and ${mcpTools.getTaskChanges.name} before you change code.`;
  if (reached.ring === 1 && reached.calls.length > 0) {
    const head = `The task “${taskName}” in ${changed.repo} changes endpoints that ${reached.repo} calls:`;
    const tail = ["", `Update ${reached.repo} to the new contract. ${read}`];
    return withinPromptLimit(head, endpointsCalledBy(changed.endpoints, reached.repo).map(endpointLine), tail);
  }
  return [
    `${reached.repo} ${reachText(changed, reached)}, which ${from} may reach through its changed endpoints.`,
    "",
    `Check whether the change reaches ${reached.repo}, and update it if it does. ${read}`,
  ].join("\n");
}

/** What links a reached repo to the change, in a few words: the endpoints it calls, or the repos it uses by address. */
export function reachText(changed: Pick<ChangedEndpoints, "endpoints">, reached: ImpactedRepo): string {
  if (reached.calls.length === 0) return `uses ${reached.uses.join(", ")}`;
  if (reached.ring === 1)
    return `calls ${endpointsCalledBy(changed.endpoints, reached.repo)
      .map((e) => `${e.method ?? "ANY"} ${e.path}`)
      .join(", ")}`;
  return `calls ${reached.calls.map((c) => `${c.method ?? "ANY"} ${c.path} of ${c.repo}`).join(", ")}`;
}

/** An endpoint's request and response types, before ⇒ after when they differ; `""` when neither side has a body. */
export function contractChange({ before, after }: Pick<ChangedEndpoint, "before" | "after">): string {
  const [b, a] = [before && contractSide(before), after && contractSide(after)];
  if (b === a || b === null || a === null) return a || b || "";
  return `${b || "no body"} ⇒ ${a || "no body"}`;
}

function contractSide({ request, response }: { request: string | null; response: string | null }): string {
  return [request && `request ${request}`, response && `response ${response}`].filter((p) => p !== null).join(", ");
}

function endpointLine(e: ChangedEndpoint): string {
  const side = e.after && contractSide(e.after);
  const contract = side ? ` (${side})` : "";
  const dtos = e.dtos.length > 0 ? `; DTOs changed: ${e.dtos.join(", ")}` : "";
  const calls = e.callers.map((c) => `${c.client} at ${c.evidence.path}:${c.evidence.line}`).join(", ");
  return `- ${e.change} ${e.method ?? "ANY"} ${e.path}${contract}${dtos}, called by ${calls}`;
}

/** `head`, as many of `lines` as fit a task's prompt with a line counting the rest, and `tail`. */
function withinPromptLimit(head: string, lines: readonly string[], tail: readonly string[]): string {
  const whole = [head, ...lines, ...tail].join("\n");
  if (whole.length <= TASK_PROMPT_MAX) return whole;
  for (let kept = lines.length - 1; kept >= 0; kept--) {
    const prompt = [head, ...lines.slice(0, kept), `- and ${lines.length - kept} more endpoints`, ...tail].join("\n");
    if (prompt.length <= TASK_PROMPT_MAX) return prompt;
  }
  return [head, `- ${lines.length} endpoints`, ...tail].join("\n");
}
