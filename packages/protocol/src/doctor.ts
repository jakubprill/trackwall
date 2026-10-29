import { z } from "zod";
import type { Endpoint } from "./api.ts";

/**
 * Contract of the `doctor` module (ADR-101): checks of what Trackwall needs on this computer (the projects folder and, on
 * Linux, whether it is mounted from the host, the keys of `workspace.yaml` (ADR-108), git, Copilot CLI and its trusted
 * folders, mise, the Java language server of tasks (ADR-123), `gh` and `glab` for the repo hosts), each with what to do
 * when it fails. It only reads; it changes nothing. Every action is `POST /api/doctor/<action>`.
 */

/** What a check is about; one check per item, in this order. */
export const DoctorCheckId = z.enum([
  "projects-folder",
  "projects-folder-storage",
  "workspace-file",
  "git",
  "copilot-cli",
  "copilot-trusted-folder",
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

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/doctor/${action}`, request, data };
}

export const doctorApi = {
  /** Runs every check now; each has a time limit, so the report comes within seconds also without a network. */
  run: endpoint("run", z.object({}).strict(), DoctorReport),
};
