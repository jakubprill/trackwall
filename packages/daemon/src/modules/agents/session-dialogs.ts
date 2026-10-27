import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentDialog } from "@trackwall/protocol";
import { readAgentDialog, type ScreenDialog } from "./copilot-dialog.ts";
import type { SessionKey } from "./copilot-keys.ts";

/**
 * The agent dialogs one session's screen shows, with the ids an answer from outside the terminal names (§4.4, ADR-66).
 * What it guarantees: an id names one dialog of one wait, so an answer never reaches a dialog the user did not see.
 * Each wait (an entry into `Approval` or `Input`, `waitStarted`) and each answer to an approval (`answered`) starts a
 * new set of ids, since the same text may come again as another request: an agent repeating a command, or two tools
 * called at once with the same command. The approval just answered is no dialog while the screen still shows it: with
 * several approval requests at once the session stays in `Approval` after an answer, and that dialog read again would
 * name the next one, which nobody saw. It is forgotten only once the screen shows anything else
 * (`forgetAnswerOffScreen`), so the next dialog with the same text drawn without a change in between has no id, never
 * a wrong one.
 */

/** The screen image the dialogs are read from (`TerminalScreen`). */
interface DialogScreen {
  readonly revision: number;
  lines(): readonly string[];
}

/** A digest of the dialog's text and of the set of ids it belongs to. */
function dialogId(ids: number, dialog: ScreenDialog): string {
  return createHash("sha256")
    .update(JSON.stringify([ids, dialog]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The same dialog on the screen. The title is left out: a box cut above takes it from the last hook's notice, which a
 * later hook clears, and the answered dialog must stay answered when only that changes.
 */
function sameDialog(a: ScreenDialog | undefined, b: ScreenDialog | undefined): boolean {
  return a !== undefined && b !== undefined && isDeepStrictEqual({ ...a, title: "" }, { ...b, title: "" });
}

/**
 * Whether `key` (typed as `data`) selects an option of `dialog`: Enter selects the marked one, and a digit only one the
 * dialog offers (a "No" option's digit only moves the selection there, and a digit of no option does nothing).
 */
export function selectsOption(dialog: AgentDialog, key: SessionKey, data: string): boolean {
  if (dialog.kind !== "approval") return false;
  return key === "enter" || (key === "choice" && dialog.options.some((o) => o.key === data));
}

export class SessionDialogs {
  readonly #screen: DialogScreen;
  /** Counts the sets of ids: waits and answers to approvals. */
  #ids = 0;
  /** The dialog last read, for the screen revision it was read at: the screen is read once per change. */
  #read: { revision: number; kind: AgentDialog["kind"]; notice: string | undefined; found: ScreenDialog | undefined } | undefined;
  #answered: ScreenDialog | undefined;
  /** The text of the last hook if it was an approval request ("Use MCP tool: …"): the heading of an approval box cut above. */
  #notice: string | undefined;

  constructor(screen: DialogScreen) {
    this.#screen = screen;
  }

  /** The session entered a state that waits for a dialog's answer. */
  waitStarted(): void {
    this.#ids++;
  }

  /** The last hook record was the approval request with this text, or `undefined` for any other hook. */
  noticed(notice: string | undefined): void {
    this.#notice = notice;
  }

  /** The dialog of `kind` the screen shows now, unless it is the approval just answered. */
  onScreen(kind: AgentDialog["kind"]): AgentDialog | null {
    const found = this.#readScreen(kind);
    if (found === undefined || (kind === "approval" && sameDialog(found, this.#answered))) return null;
    return { ...found, id: dialogId(this.#ids, found) };
  }

  /** Whether the screen shows an approval dialog, answered or not: a key typed into it is no text for the input box. */
  approvalDrawn(): boolean {
    return this.#readScreen("approval") !== undefined;
  }

  /** The user answered the approval the screen shows now. */
  answered(): void {
    this.#answered = this.#readScreen("approval") ?? this.#answered;
    this.#ids++;
  }

  forgetAnswerOffScreen(): void {
    if (this.#answered !== undefined && !sameDialog(this.#readScreen("approval"), this.#answered)) this.#answered = undefined;
  }

  #readScreen(kind: AgentDialog["kind"]): ScreenDialog | undefined {
    const revision = this.#screen.revision;
    const read = this.#read;
    const notice = this.#notice;
    if (read?.revision === revision && read.kind === kind && read.notice === notice) return read.found;
    const found = readAgentDialog(this.#screen.lines(), kind, notice);
    this.#read = { revision, kind, notice, found };
    return found;
  }
}
