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
};
