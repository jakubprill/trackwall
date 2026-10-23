import { HOST_CLI, type RepoHost } from "@trackwall/protocol";

/** Nazwy hostingów repo w UI (ADR-19). */
export const HOST_KIND_LABEL: Record<RepoHost["kind"], string> = { gitlab: "GitLab", github: "GitHub" };

/** Komenda, którą użytkownik loguje program hostingu; Trackwall nie przechowuje tokenu (ADR-19). */
export function loginCommand(host: RepoHost): string {
  return `${HOST_CLI[host.kind]} auth login --hostname ${host.host}`;
}
