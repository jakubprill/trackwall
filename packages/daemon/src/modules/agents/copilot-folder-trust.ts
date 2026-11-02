import { readAgentDialog } from "./copilot-dialog.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Copilot CLI asking whether to trust the folder it starts in (§4.4), read from the session's screen. Copilot CLI
 * 1.0.103 asks before any hook, in a session and its resume alike, when the folder is not in `trustedFolders` of its
 * `config.json` (the doctor's check, ADR-101): a box like an approval's, headed "Confirm folder trust", with the folder,
 * "Do you trust the files in this folder?" and the options "Yes", "Yes, and remember this folder for future sessions"
 * and "No (Esc)". No hook tells of it, so without the screen the session had no state and nobody learned it waits. The
 * screen of the real binary is the fixture `test/fixtures/copilot/dialog-folder-trust-120.txt`; the contract tests check
 * the reading on the pinned version. A terminal sequence that set a state before the dialog would outrank the screen
 * (`task-state-tracker.ts`); the pinned version sends none.
 */

const FOLDER_TRUST_TITLE = "Confirm folder trust";

/** The dialog waits for an answer like an approval: the tray, the notification and the dialog's buttons follow from it. */
const FOLDER_TRUST: StateSignal = {
  state: "Approval",
  source: "screen",
  confidence: "medium",
  reason: "screen folder trust dialog",
};

/** The folder trust dialog on the screen (its visible lines, top to bottom) as a state, or `undefined`. */
export function stateFromFolderTrust(lines: readonly string[]): StateSignal | undefined {
  const dialog = readAgentDialog(lines, "approval");
  return dialog?.kind === "approval" && dialog.title === FOLDER_TRUST_TITLE ? FOLDER_TRUST : undefined;
}
