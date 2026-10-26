import { type HostedProject, RemoteRepoName, type RepoHost } from "@trackwall/protocol";

/** GitHub needs no entry in the settings: its address is the same for everyone. */
const GITHUB_HOST = "github.com";

/**
 * The repo's main remote (`host/path`, ADR-21) as a project on a repo host (ADR-77): a repo host from the settings with the
 * same host name, or GitHub; `null` for any other host, because the daemon does not guess what a host runs. A remote
 * address carries no port, so a repo host from the settings matches by its name alone and keeps its port for the links.
 */
export function hostedProject(address: string, hosts: readonly RepoHost[]): HostedProject | null {
  const slash = address.indexOf("/");
  const name = address.slice(0, slash);
  const path = address.slice(slash + 1);
  // The path goes into API paths and the form's address, so only the names repo hosts themselves create.
  if (slash < 0 || !RemoteRepoName.safeParse(path).success) return null;
  const configured = hosts.find((h) => withoutPort(h.host) === name);
  if (configured) return { kind: configured.kind, host: configured.host, path };
  return name === GITHUB_HOST ? { kind: "github", host: GITHUB_HOST, path } : null;
}

function withoutPort(host: string): string {
  return host.replace(/:\d+$/, "");
}
