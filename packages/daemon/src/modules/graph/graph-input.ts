import type { GraphConfig, RepoCard, RepoTag } from "@trackwall/protocol";

/** The input of joining cards into the graph (§4.6, ADR-29): cards from the `cards` module and `graph` entries from `workspace.yaml`. */

/** A repo card from the list, as the `cards` module gives it (`Cards.all`). */
export type GraphCardInput =
  | { kind: "ok"; repo: string; remote: string | null; card: RepoCard | null; tags: RepoTag[] }
  | { kind: "unavailable"; repo: string; message: string };

export interface GraphConfigInput {
  config: GraphConfig;
  /** The full path of `workspace.yaml`: the evidence of an alias and a manual edge. */
  file: string;
  /** `workspace.yaml` keys that could not be read (a bad `graph` or `repoTags`); they go into `configProblems`. */
  problems: string[];
}
