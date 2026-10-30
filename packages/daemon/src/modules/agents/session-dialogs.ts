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
 *
 * A box cut above in a short terminal has no heading, and the text of its approval request hook stands in (`requested`).
 * Only while the wait has a single request: several requests come at once and in either order, so their texts cannot be
 * matched to the dialogs, and a heading naming another command than the one approved would mislead. A dialog's identity
 * (its id, and whether it is the one answered) leaves the heading out, so a request that comes later does not change it.
 */

/** The screen image the dialogs are read from (`TerminalScreen`). */
interface DialogScreen {
  readonly revision: number;
  lines(): readonly string[];
}

/** What identifies a dialog: all its text but the heading, which a box cut above takes from its requests (`requested`). */
const identity = (dialog: ScreenDialog) => ({ ...dialog, title: "" });

/** A digest of the dialog's identity and of the set of ids it belongs to. */
function dialogId(ids: number, dialog: ScreenDialog): string {
  return createHash("sha256")
    .update(JSON.stringify([ids, identity(dialog)]))
    .digest("hex")
    .slice(0, 16);
}

function sameDialog(a: ScreenDialog | undefined, b: ScreenDialog | undefined): boolean {
  return a !== undefined && b !== undefined && isDeepStrictEqual(identity(a), identity(b));
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
  /** The id last given, so that a dialog asked for every cycle is not hashed again while the screen and the ids hold. */
  #lastId: { ids: number; found: ScreenDialog; id: string } | undefined;
  #answered: ScreenDialog | undefined;
  /** The texts of the wait's approval request hooks ("Use MCP tool: …"); `CopilotSessionState` counts the unanswered ones. */
  #requests: (string | undefined)[] = [];

  constructor(screen: DialogScreen) {
    this.#screen = screen;
  }

  /**
   * The session entered a state that waits for a dialog's answer. `sameRequests`: it waits again for a request that
   * came at once with those of the last wait, which an answer given before its hook ended (ADR-71).
   */
  waitStarted(sameRequests: boolean): void {
    this.#ids++;
    if (!sameRequests) this.#requests = [];
  }

  /** An approval request hook with this text came, after the state change it gave (`waitStarted`). */
  requested(text: string | undefined): void {
    this.#requests.push(text);
  }

  /** The dialog of `kind` the screen shows now, unless it is the approval just answered. */
  onScreen(kind: AgentDialog["kind"]): AgentDialog | null {
    const found = this.#readScreen(kind);
    if (found === undefined || (kind === "approval" && sameDialog(found, this.#answered))) return null;
    const last = this.#lastId;
    const id = last?.ids === this.#ids && last.found === found ? last.id : dialogId(this.#ids, found);
    this.#lastId = { ids: this.#ids, found, id };
    return { ...found, id };
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
    const notice = this.#requests.length === 1 ? this.#requests[0] : undefined;
    if (read?.revision === revision && read.kind === kind && read.notice === notice) return read.found;
    const found = readAgentDialog(this.#screen.lines(), kind, notice);
    this.#read = { revision, kind, notice, found };
    return found;
  }
}
