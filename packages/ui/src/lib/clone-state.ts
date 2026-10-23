import { type CloneJob, type RemoteRepo, type RepoHost, sameHost } from "@trackwall/protocol";

/** Co wiersz repo z hostingu pokazuje zamiast przycisku „Sklonuj” (ADR-19); czyste funkcje, testy w `test/clone-state.test.ts`. */
export type CloneState =
  | { kind: "available" }
  | { kind: "in-projects-dir" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

/** Klonowanie z tej sesji daemona ma pierwszeństwo przed tym, co było w folderze przy wyszukiwaniu. */
export function cloneState(host: RepoHost, repo: RemoteRepo, jobs: readonly CloneJob[]): CloneState {
  const job = jobs.findLast((j) => sameHost(j.host, host) && j.fullName === repo.fullName);
  if (job?.state === "failed") return { kind: "failed", message: job.message ?? "klonowanie się nie udało" };
  if (job) return { kind: job.state };
  return repo.inProjectsDir ? { kind: "in-projects-dir" } : { kind: "available" };
}

export const HOST_KIND_LABEL: Record<RepoHost["kind"], string> = { gitlab: "GitLab", github: "GitHub" };

/** Komenda, którą użytkownik loguje program hostingu; Trackwall nie przechowuje tokenu (ADR-19). */
export function loginCommand(host: RepoHost): string {
  return `${host.kind === "gitlab" ? "glab" : "gh"} auth login --hostname ${host.host}`;
}
