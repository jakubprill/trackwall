import { readAgentDialog } from "./copilot-dialog.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * The dialogs Copilot CLI shows before its first hook (§4.4), read from the session's screen. No hook tells of them, so
 * without the screen the session had no state and nobody learned it waits. Each is a box like an approval's, and each
 * waits for an answer like one: the tray, the notification and the dialog's buttons follow from that.
 *
 * - Folder trust: Copilot CLI 1.0.103 asks before any hook, in a session and its resume alike, when the folder is not
 *   in `trustedFolders` of its `config.json` (the doctor's check, ADR-101): "Confirm folder trust", with the folder,
 *   "Do you trust the files in this folder?" and the options "Yes", "Yes, and remember this folder for future sessions"
 *   and "No (Esc)". The screen of the real binary is the fixture `test/fixtures/copilot/dialog-folder-trust-120.txt`;
 *   the contract tests check the reading on the pinned version.
 * - The sandbox's certificate authority (ADR-181): Copilot CLI 1.0.107 started with `--sandbox` on macOS (and on a
 *   Windows account that can elevate) offers to install the certificate authority of its credential proxy into the
 *   system's trust store, or an updated one when its credential hosts changed: "Install the proxy certificate authority?"
 *   with "Install certificate authority" and "Continue without installing (Esc)". It shows instead of the session, so
 *   a task's prompt waits behind it. Installing changes what the whole system trusts (the login Keychain on macOS), so
 *   the dialog offers only "Continue without installing" outside the terminal (`copilot-dialog.ts`). Copilot CLI offers
 *   it on Linux never, so the fixture `test/fixtures/copilot/dialog-sandbox-ca-120.txt` comes from the real binary on
 *   Linux with the offer forced and the macOS texts in place (ADR-241).
 *
 * A terminal sequence that set a state before the dialog would outrank the screen (`task-state-tracker.ts`); the pinned
 * version sends none.
 */

/** Each dialog by its heading, with the reason of the state it gives. */
const START_DIALOGS: ReadonlyMap<string, string> = new Map([
  ["Confirm folder trust", "screen folder trust dialog"],
  ["Install the proxy certificate authority?", "screen sandbox certificate authority dialog"],
  ["Update the proxy certificate authority?", "screen sandbox certificate authority dialog"],
]);

/** A dialog shown before the first hook: its heading, and the state it gives. */
export interface StartDialog {
  title: string;
  signal: StateSignal;
}

/** The dialog Copilot CLI shows before its first hook on the screen (its visible lines, top to bottom), or `undefined`. */
export function startDialogOnScreen(lines: readonly string[]): StartDialog | undefined {
  const dialog = readAgentDialog(lines, "approval");
  if (dialog?.kind !== "approval") return undefined;
  const reason = START_DIALOGS.get(dialog.title);
  if (reason === undefined) return undefined;
  return { title: dialog.title, signal: { state: "Approval", source: "screen", confidence: "medium", reason } };
}
