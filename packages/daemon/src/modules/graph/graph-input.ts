import type { GraphConfig, RepoCard, RepoTag } from "@trackwall/protocol";

/** Wejście złączenia kart w graf (§4.6, ADR-29): karty z modułu `cards` i wpisy `graph` z `workspace.yaml`. */

/** Karta repo z listy, tak jak podaje ją moduł `cards` (`Cards.all`). */
export type GraphCardInput =
  | { kind: "ok"; repo: string; remote: string | null; card: RepoCard | null; tags: RepoTag[] }
  | { kind: "unavailable"; repo: string; message: string };

export interface GraphConfigInput {
  config: GraphConfig;
  /** Pełna ścieżka `workspace.yaml`: dowód aliasu i ręcznej krawędzi. */
  file: string;
  /** Klucze `workspace.yaml`, których nie dało się przeczytać (zły `graph` albo `repoTags`); trafiają do `configProblems`. */
  problems: string[];
}
