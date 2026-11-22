import { z } from "zod";
import { apiEndpoints } from "./api.ts";

/**
 * Contract of the `doctor` module (ADR-101): checks of what Trackwall needs on this computer (the projects folder and, on
 * Linux, whether it is mounted from the host, in a container the work there on no remote (ADR-162), the keys of
 * `workspace.yaml` (ADR-108), git, Copilot CLI and its trusted folders and sandbox (ADR-181), the network sessions reach GitHub and Copilot
 * through (ADR-166), folders an antivirus scans (ADR-255), mise, the Java language server of tasks (ADR-123), `gh` and `glab` for the repo hosts), each with what to do
 * when it fails. The checks only read, apart from small files they write and remove to time them, and change nothing; the one
 * change is `trust-projects-folder`, which the user asks for (ADR-270). Every action is `POST /api/doctor/<action>`.
 */

/** What a check is about; one check per item, in this order. */
export const DoctorCheckId = z.enum([
  "projects-folder",
  "projects-folder-storage",
  "disk-space",
  "file-scanning",
  "unpushed-work",
  "workspace-file",
  "git",
  "git-remotes",
  "copilot-cli",
  "copilot-trusted-folder",
  "copilot-sandbox",
  "network",
  "model-provider",
  "mise",
  "java-navigation",
  "github-cli",
  "gitlab-cli",
]);
export type DoctorCheckId = z.infer<typeof DoctorCheckId>;

/** `ok` works; `warn` works with a gap (an old version, a question at every session); `fail` stops a part of Trackwall. */
export const DoctorStatus = z.enum(["ok", "warn", "fail"]);
export type DoctorStatus = z.infer<typeof DoctorStatus>;

export const DoctorCheck = z.object({
  id: DoctorCheckId,
  status: DoctorStatus,
  /** What was found, in one sentence: `git 2.47.1`, `Copilot CLI not found in PATH`. */
  summary: z.string(),
  /** What to do about a `warn` or `fail`, in one or two sentences; `null` when there is nothing to do. */
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  /** In `DoctorCheckId` order; a check that does not apply (no GitLab host) is left out. */
  checks: z.array(DoctorCheck),
  checkedAt: z.string(),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

/** What `trust-projects-folder` did to Copilot CLI's `config.json` (ADR-270). */
export const TrustedProjectsFolder = z.object({
  /** Copilot CLI's `config.json`, as a full path. */
  file: z.string(),
  /** The trusted folder that covers the projects folder: itself, or a folder above it that was trusted already. */
  folder: z.string(),
  /** `false`: a trusted folder covered the projects folder already, and nothing was written. */
  added: z.boolean(),
  /** The copy of the file as it was before the change; `null` when nothing was written or there was no file. */
  backup: z.string().nullable(),
});
export type TrustedProjectsFolder = z.infer<typeof TrustedProjectsFolder>;

/**
 * How the Copilot CLI sessions start compares with `TESTED_COPILOT_CLI_VERSION` (ADR-274): `older` may lack what the daemon
 * relies on, `newer` may have changed it, `unknown` when Copilot CLI is missing, did not answer or said no version.
 */
export const CopilotCliRelation = z.enum(["older", "tested", "newer", "unknown"]);
export type CopilotCliRelation = z.infer<typeof CopilotCliRelation>;

export const CopilotCliVersion = z.discriminatedUnion("relation", [
  /**
   * What `copilot --version` says, as `x.y.z`, against the tested version, `TESTED_COPILOT_CLI_VERSION` of this daemon;
   * `inContainer` when the daemon runs in a container, where Copilot CLI comes from its mise config or image.
   */
  z.object({ relation: z.enum(["older", "tested", "newer"]), version: z.string(), tested: z.string(), inContainer: z.boolean() }),
  z.object({ relation: z.literal("unknown"), version: z.null(), tested: z.string(), inContainer: z.boolean() }),
]);
export type CopilotCliVersion = z.infer<typeof CopilotCliVersion>;

/**
 * How to get the tested Copilot CLI, for the doctor and the window's strip alike (ADR-274). In a container Copilot CLI
 * comes from the mise config the dev container guide sets up, or from the image, so an update made inside the
 * container any other way is gone at the next rebuild, and the user has to know which version to put there.
 */
export function copilotCliInstallAdvice(tested: string, inContainer: boolean): string {
  if (!inContainer) return `Install Copilot CLI ${tested} the way you installed it (npm, Homebrew or WinGet).`;
  return `Install Copilot CLI ${tested} where the container gets it: run \`mise use -g npm:@github/copilot@${tested}\` in the container, or put that version into its image and rebuild it. An update made any other way is lost at the next rebuild.`;
}

const endpoint = apiEndpoints("doctor");

export const doctorApi = {
  /** Runs every check now; each has a time limit, so the report comes within seconds also without a network. */
  run: endpoint("run", z.object({}).strict(), DoctorReport),
  /**
   * Adds the projects folder of the workspace settings to the folders Copilot CLI trusts without asking (`trustedFolders`
   * in its `config.json`), so the fix of the `copilot-trusted-folder` check is one click (ADR-270). The body names no
   * folder: the daemon takes it from its settings. `bad_request` when no projects folder is set or the file cannot be
   * changed safely; the message says why.
   */
  trustProjectsFolder: endpoint("trust-projects-folder", z.object({}).strict(), TrustedProjectsFolder),
  /**
   * Only the version of the Copilot CLI sessions start, without the other checks (ADR-274): the window asks for it when it
   * connects and every hour, and warns about a version Trackwall is not tested with. Runs `copilot --version` and nothing else.
   */
  copilotCliVersion: endpoint("copilot-cli-version", z.object({}).strict(), CopilotCliVersion),
};
