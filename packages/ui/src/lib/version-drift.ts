import {
  CHANGE_PART_NOTE_MAX,
  CHANGE_PARTS_MAX,
  type ChangePart,
  type DriftedRepo,
  type DriftKind,
  evidenceLabel,
  type RepoGraph,
  TASK_TITLE_MAX,
  type VersionDrift,
} from "@trackwall/protocol";

/**
 * Version drift in the "Overview" view (§4.6, ADR-196): its words for a person, the repos that differ from its target,
 * and the prompt, title and parts of the change that aligns them, which the user reads and edits before it starts.
 */

const KIND_LABELS: Record<DriftKind, string> = {
  tool: "tool",
  "spring-boot": "framework",
  parent: "parent or BOM",
  plugin: "build plugin",
};

/** Tool names mise uses, spelled the way people write them. */
const TOOL_NAMES: Record<string, string> = { java: "Java", node: "Node.js", maven: "Maven", gradle: "Gradle" };

/** What the drift is about: `Java`, `Spring Boot`, `maven-surefire-plugin`. A package keeps its artifact, its group is in `name`. */
export function driftSubject(drift: Pick<VersionDrift, "kind" | "name">): string {
  if (drift.kind === "spring-boot") return "Spring Boot";
  if (drift.kind === "tool") return TOOL_NAMES[drift.name] ?? drift.name;
  return drift.name.slice(drift.name.lastIndexOf(":") + 1);
}

export function driftKindLabel(kind: DriftKind): string {
  return KIND_LABELS[kind];
}

/** A drift's key in a list: its kind and subject, unique in a graph. */
export function driftKey(drift: Pick<VersionDrift, "kind" | "name">): string {
  return `${drift.kind}:${drift.name}`;
}

/** Whether a repo is on the drift's target in every module, so there is nothing to align in it. */
export function onTarget(drift: Pick<VersionDrift, "target">, repo: DriftedRepo): boolean {
  return repo.versions.every((v) => v === drift.target);
}

/** The repos to align: every repo with a version other than the target. */
export function reposToAlign(drift: VersionDrift): DriftedRepo[] {
  return drift.repos.filter((r) => !onTarget(drift, r));
}

/** A repo's drifts with its own versions in each, in the graph's order. */
export function repoDrift(graph: Pick<RepoGraph, "drift">, repo: string): { drift: VersionDrift; own: DriftedRepo }[] {
  return graph.drift.flatMap((drift) => {
    const own = drift.repos.find((r) => r.repo === repo);
    return own ? [{ drift, own }] : [];
  });
}

/** The repos the form starts with: a change has at most `CHANGE_PARTS_MAX` parts, so the first ones in the list. */
export function initialAlignRepos(drift: VersionDrift): string[] {
  return reposToAlign(drift)
    .slice(0, CHANGE_PARTS_MAX)
    .map((r) => r.repo);
}

/** The change's title, which also names its branch: `Align Java to 21`. */
export function alignTitle(drift: VersionDrift): string {
  return `Align ${driftSubject(drift)} to ${drift.target}`.slice(0, TASK_TITLE_MAX);
}

/** What every repo's agent is asked to do; each part's note says what its repo has now and where. */
export function alignPrompt(drift: VersionDrift): string {
  const what =
    drift.kind === "tool" || drift.kind === "spring-boot" ? driftSubject(drift) : `${drift.name} (${driftKindLabel(drift.kind)})`;
  return (
    `Move this repo to ${what} ${drift.target}, the newest version other repos in the projects folder use. ` +
    "Change the version where the note below says, and anything the new version needs, such as a deprecated API or a changed setting. " +
    "Build the project and run its tests, and say what you changed and what you could not move."
  );
}

/** A repo's part: its versions and the lines that give them, cut to fit a part's note. */
export function alignPart(repo: DriftedRepo): ChangePart {
  const where = repo.evidence.map((e) => `${evidenceLabel(e)}: ${e.detail}`).join(", ");
  return { repo: repo.repo, note: `it uses ${repo.versions.join(", ")} at ${where}`.slice(0, CHANGE_PART_NOTE_MAX) };
}
