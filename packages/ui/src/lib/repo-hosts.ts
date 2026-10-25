import { HOST_CLI, type RepoHost } from "@trackwall/protocol";

/** Names of repo hosts in the UI (ADR-19). */
export const HOST_KIND_LABEL: Record<RepoHost["kind"], string> = { gitlab: "GitLab", github: "GitHub" };

/** The command the user signs in to the repo host's program with; Trackwall does not store the token (ADR-19). */
export function loginCommand(host: RepoHost): string {
  return `${HOST_CLI[host.kind]} auth login --hostname ${host.host}`;
}
