import {
  type AgentSecrets,
  countLabel,
  type DayStartSettings,
  type GraphConfig,
  type JavaNavigationSettings,
  type RepoHost,
  type RepoTagRules,
  type SupervisorSettings,
  type ToolPermissionRules,
  trackwallDirLabel,
  type WorkspaceKey,
} from "@trackwall/protocol";

/**
 * A key of `workspace.yaml` in one line for the view of the config files (ADR-108): a path as it is, a list by its names
 * or its count, never the whole value, which only the file shows in full.
 */

/** The value of each key as `WorkspaceFile` reads it. */
export interface WorkspaceKeyValues {
  projectsDir: string | null;
  worktreesDir: string | null;
  gitProgram: string | null;
  repoHosts: RepoHost[];
  toolPermissions: ToolPermissionRules;
  agentSecrets: AgentSecrets;
  supervisor: SupervisorSettings;
  repoTags: RepoTagRules;
  dayStart: DayStartSettings | null;
  graph: GraphConfig;
  javaNavigation: JavaNavigationSettings | null;
}

/** How long a value from the file may be in the line; a longer one is cut. */
const MAX_VALUE_CHARS = 120;

export const workspaceKeyValue: { [K in WorkspaceKey]: (value: WorkspaceKeyValues[K]) => string } = {
  projectsDir: (dir) => dir ?? "not set",
  worktreesDir: (dir) => dir ?? `${trackwallDirLabel("worktrees")} in the projects folder`,
  gitProgram: (path) => path ?? "git from PATH",
  repoHosts: (hosts) => (hosts.length === 0 ? "none" : hosts.map((h) => h.host).join(", ")),
  toolPermissions: (rules) => (rules.length === 0 ? "none" : countLabel(rules.length, { one: "rule", other: "rules" })),
  agentSecrets: (names) => (names.length === 0 ? "none" : names.join(", ")),
  supervisor: (settings) => `changesCode: ${settings.changesCode}`,
  repoTags: (rules) => {
    const tags = Object.keys(rules);
    return tags.length === 0 ? "none" : `${countLabel(tags.length, { one: "tag", other: "tags" })}: ${tags.join(", ")}`;
  },
  dayStart: (settings) => (settings === null ? "not set" : `prompt: ${oneLine(settings.prompt)}`),
  graph: (graph) => {
    const parts = [
      countLabel(Object.keys(graph.packages).length, { one: "package alias", other: "package aliases" }),
      countLabel(Object.keys(graph.apps).length, { one: "app alias", other: "app aliases" }),
      countLabel(graph.edges.length, { one: "edge", other: "edges" }),
    ];
    return parts.join(", ");
  },
  javaNavigation: (settings) => (settings === null ? "not set" : `jdtls: ${settings.jdtls}`),
};

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_VALUE_CHARS ? `${line.slice(0, MAX_VALUE_CHARS - 1)}…` : line;
}
