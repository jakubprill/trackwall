import type { DoctorReport, TrackwallError } from "@trackwall/protocol";

/**
 * The diagnostics for a bug report (§4.14, criterion 8 of the 1.0 plan): what someone looking into a problem asks first,
 * the version and the system, every doctor check and Trackwall's own errors, as Markdown to paste into an issue. The
 * doctor's words name the user's folders and hosts, so each goes through the journal's anonymization; the errors already
 * did when they were kept.
 */

/** Where this Trackwall runs, as the first line says it. */
export interface DiagnosticsSystem {
  version: string;
  /** `win32 x64 10.0.22631`, from `node:os`. */
  system: string;
  /** `Bun 1.4.4` or `Node 24.11.0`. */
  runtime: string;
  inContainer: boolean;
}

/** The text "Copy diagnostics" puts on the clipboard; `anonymize` replaces the user's values in a line of the doctor. */
export function diagnosticsText(
  system: DiagnosticsSystem,
  doctor: DoctorReport,
  errors: readonly TrackwallError[],
  anonymize: (text: string) => string,
): string {
  const where = system.inContainer ? "in a container" : "on this computer";
  const checks = doctor.checks.map((check) => {
    const line = `- ${check.status} · ${check.id}: ${anonymize(check.summary)}`;
    return check.fix === null ? line : `${line}\n  Fix: ${anonymize(check.fix)}`;
  });
  return [
    "# Trackwall diagnostics",
    `Trackwall ${system.version}, daemon on ${system.system}, ${system.runtime}, ${where}. Checked at ${doctor.checkedAt}.`,
    "## Doctor",
    checks.join("\n"),
    `## Trackwall errors (${errors.length})`,
    errors.length === 0 ? "No errors." : errors.map(errorLines).join("\n"),
  ].join("\n\n");
}

/** One error of the journal: where and what, how often and when, its message and its top frames. */
function errorLines(error: TrackwallError): string {
  const times = error.count === 1 ? "1 time" : `${error.count} times`;
  const head = `- ${error.source} ${error.area} · ${error.kind} · ${times}, last ${error.lastSeen} on ${error.version}`;
  const frames = error.frames.slice(0, 3).map((frame) => `  at ${frame}`);
  return [head, `  ${error.message}`, ...frames].join("\n");
}
