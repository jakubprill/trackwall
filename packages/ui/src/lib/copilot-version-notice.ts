import { type CopilotCliVersion, copilotCliInstallAdvice } from "@trackwall/protocol";

/**
 * The strip above the views about a Copilot CLI Trackwall is not tested with (ADR-274). The contract tests pin one
 * version; Copilot CLI updates itself, so a user gets a newer one before a Trackwall tested with it, and a change in its
 * hooks or screen can then make Trackwall show a session's state wrong. "Hide" is a convenience of this browser profile,
 * kept in `localStorage` for that one version, so the next version shows the strip again; storage can be missing or
 * refuse access, so a failure reads as not hidden and a write that fails is forgotten.
 */
const HIDDEN_KEY = "trackwall.copilot-version-notice.hidden";

/** The strip's sentence, or `null` when there is nothing to say: the tested version, no version, or hidden for this one. */
export function copilotVersionNotice(found: CopilotCliVersion, hiddenFor: string | null): string | null {
  if (found.relation === "unknown" || found.relation === "tested" || found.version === hiddenFor) return null;
  const { version, tested } = found;
  return found.relation === "newer"
    ? `Copilot CLI ${version} is newer than ${tested}, the version this Trackwall is tested with: a session's state may show wrong until Trackwall is updated.`
    : `Copilot CLI ${version} is older than ${tested}, the version this Trackwall is tested with, so sessions may lack what Trackwall relies on. ${copilotCliInstallAdvice(tested, found.inContainer)}`;
}

/** The version the strip was hidden for, `null` when it never was. */
export function readNoticeHiddenFor(storage: () => Pick<Storage, "getItem">): string | null {
  try {
    return storage().getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
}

export function saveNoticeHiddenFor(storage: () => Pick<Storage, "setItem">, version: string): void {
  try {
    storage().setItem(HIDDEN_KEY, version);
  } catch {
    // The strip goes away in this window; only the next one shows it again.
  }
}
