import { z } from "zod";

/**
 * Repo hosts (§4.5, ADR-19): GitHub or GitLab, from which Trackwall lists the available repos and clones the chosen ones
 * into the projects folder. The repo host's address lives only in the user's `workspace.yaml` (ADR-7).
 */

export const RepoHostKind = z.enum(["github", "gitlab"]);
export type RepoHostKind = z.infer<typeof RepoHostKind>;

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * A host name, optionally with a port, without scheme and path (`gitlab.example.com`, `git.local:8443`). Lowercase,
 * because that is how the daemon compares them and how `gh` and `glab` store them.
 */
export const HostName = z
  .string()
  .max(253)
  .transform((h) => h.toLowerCase())
  .pipe(
    z
      .string()
      .regex(new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`), "host name without https:// and path, e.g. gitlab.example.com"),
  );

export const RepoHost = z.object({ kind: RepoHostKind, host: HostName }).strict();
export type RepoHost = z.infer<typeof RepoHost>;

/** The program through which the daemon queries a repo host and clones from it (ADR-19); the user signs in with it themselves. */
export const HOST_CLI: Record<RepoHostKind, "gh" | "glab"> = { github: "gh", gitlab: "glab" };

export function sameHost(a: RepoHost, b: RepoHost): boolean {
  return a.kind === b.kind && a.host === b.host;
}

/** The repo host key, for example `gitlab:gitlab.example.com`: for maps and list keys in the UI. */
export function hostKey(host: RepoHost): string {
  return `${host.kind}:${host.host}`;
}

/** The list of repo hosts from `workspace.yaml` and settings: without repeats, because each repo host is one section of results. */
export const RepoHosts = z
  .array(RepoHost)
  .max(20)
  .refine(
    (hosts) => hosts.every((h, i) => hosts.findIndex((other) => sameHost(h, other)) === i),
    "the same host appears twice in the list",
  );

/** A segment of a repo path on a repo host: characters GitHub and GitLab allow, without `.` and `-` at the start. */
const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._-]*";

/**
 * The full name of a repo on a repo host: `owner/repo` on GitHub, `group/subgroup/project` on GitLab. The last segment is
 * the clone's directory name. No `-` at the start of a segment, so the name is not taken for a `gh` or `glab` option.
 */
export const RemoteRepoName = z
  .string()
  .max(512)
  .regex(new RegExp(`^${SEGMENT}(?:/${SEGMENT})+$`), "full repo name, e.g. owner/repo or group/subgroup/repo");
export type RemoteRepoName = z.infer<typeof RemoteRepoName>;

/** A repo available on a repo host to the signed-in `gh` or `glab` user, as the repo host gave it. */
export const HostedRepo = z.object({
  fullName: RemoteRepoName,
  description: z.string().nullable(),
  webUrl: z.string(),
  /** ISO 8601, the last change on the repo host; `null` when the repo host did not give it. */
  updatedAt: z.string().nullable(),
});
export type HostedRepo = z.infer<typeof HostedRepo>;

/** A repo from a repo host with what the daemon knows about the projects folder. */
export const RemoteRepo = HostedRepo.extend({
  /** The directory the clone goes to: the last segment of `fullName`. */
  dir: z.string(),
  /** The projects folder already has something named `dir` (compared case-insensitively), so the clone would fail. */
  inProjectsDir: z.boolean(),
});
export type RemoteRepo = z.infer<typeof RemoteRepo>;

export const HostRepos = z.object({
  host: RepoHost,
  listing: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ok"),
      /** Without archived ones, in the repo host's order: GitHub by name, GitLab most recently changed first. */
      repos: z.array(RemoteRepo),
      /** The repo host has more repos than Trackwall fetches (§4.5), so results may be missing; narrowing the search helps. */
      truncated: z.boolean(),
    }),
    /** `gh` or `glab` did not answer: the program is missing, not signed in, no network; details in `message`. */
    z.object({ kind: z.literal("unavailable"), message: z.string() }),
  ]),
});
export type HostRepos = z.infer<typeof HostRepos>;

const CloneTarget = z.object({
  host: RepoHost,
  fullName: RemoteRepoName,
  /** The full path of the clone's directory. */
  path: z.string(),
});

/** Cloning one repo into the projects folder; kept in the daemon's memory until it restarts. */
export const CloneJob = z.discriminatedUnion("state", [
  CloneTarget.extend({ state: z.enum(["running", "done"]) }),
  /** `message` is the message from `gh` or `glab`. */
  CloneTarget.extend({ state: z.literal("failed"), message: z.string() }),
]);
export type CloneJob = z.infer<typeof CloneJob>;

export const CloneRequest = z.object({ host: RepoHost, fullName: RemoteRepoName }).strict();
export type CloneRequest = z.infer<typeof CloneRequest>;
