import { type AgentDialog, agentsApi, type DialogAnswer } from "@trackwall/protocol";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { PatchLines } from "@/components/PatchLines";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { PATCH_SHOWN_LINES } from "@/lib/conversation";
import { keyAnswerTooSoon, optionAfterKey, writingIn } from "@/lib/dialog-keyboard";
import { changeLines } from "@/lib/diff-lines";
import { keyboardInRegion } from "@/lib/keyboard-elsewhere";
import { useAction } from "@/lib/use-action";

/**
 * The agent dialog of a session waiting for you (ADR-66), outside its terminal: what the agent asks, and for an approval
 * Copilot CLI's own options and Stop. A click types the option's key into the session; the daemon types it only while
 * the screen still shows this dialog, so a dialog answered in the terminal meanwhile only says so (`dialog_changed`).
 * Keyed by the session and the dialog's id where it is used, so a new dialog starts without the previous one's error;
 * once answered, the buttons stay off until the session's next state replaces the card. The texts come from the agent
 * and the repo, so they are plain text; an approval over ACP also shows the change it allows in colour
 * (ADR-107). A question is answered in the session terminal (`onOpen`). An approval that shows where the user works
 * (`takesKeyboard`, in the supervisor panel while the keyboard is in it) takes the keyboard to its first option, unless the
 * user is writing a message; the arrows move between its options and Enter picks one, though not in the first moment, so
 * that an Enter meant for the message just sent does not answer it.
 */
/** Marks the buttons of Copilot CLI's options, which the arrows move between. */
const OPTION = "data-dialog-option";

export function AgentDialogCard({
  conn,
  session,
  dialog,
  onOpen,
  takesKeyboard,
  onKeyboardLeaves,
}: {
  conn: Connection;
  session: string;
  dialog: AgentDialog;
  onOpen: () => void;
  /** The card shows where the keyboard is, so its approval takes the keyboard when it shows. */
  takesKeyboard: boolean;
  /** An answer given with the keyboard on the card: the card goes, so the keyboard goes back to where the user writes. */
  onKeyboardLeaves?: () => void;
}) {
  const [answered, setAnswered] = useState(false);
  const answer = useAction(
    (key: DialogAnswer) => post(conn, agentsApi.answerDialog, { session, dialog: dialog.id, answer: key }),
    () => setAnswered(true),
  );
  const disabled = answer.pending || answered;
  const options = useRef<HTMLFieldSetElement>(null);
  // The answers the arrows move between: Copilot CLI's options, without "Stop the agent".
  const optionButtons = () => [...(options.current?.querySelectorAll<HTMLButtonElement>(`button[${OPTION}]`) ?? [])];
  const shownAt = useRef(performance.now());
  // Only as the approval shows (the card is keyed by its dialog), and only when the keyboard is already in the
  // supervisor panel around it: an approval elsewhere, or a later focus in the panel, leaves the keyboard where it is.
  const takesKeyboardAtShow = useRef(takesKeyboard);
  useEffect(() => {
    const focused = document.activeElement;
    const card = options.current;
    if (takesKeyboardAtShow.current && card && keyboardInRegion(card, focused) && !writingIn(focused)) optionButtons()[0]?.focus();
  }, []);
  const moveBetweenOptions = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const buttons = optionButtons();
    const current = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
    const next = current === -1 ? undefined : optionAfterKey(event.key, current, buttons.length);
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  // A click from Enter or Space has no pointer (`detail` 0).
  const pick = (key: DialogAnswer, event: MouseEvent<HTMLButtonElement>) => {
    if (keyAnswerTooSoon(event.detail === 0, performance.now() - shownAt.current)) return;
    if (options.current?.contains(document.activeElement)) onKeyboardLeaves?.();
    answer.run(key);
  };
  const change = dialog.kind === "approval" ? changeLines(dialog.patch ?? "", PATCH_SHOWN_LINES, dialog.patchCut ?? false) : undefined;
  return (
    <div className="flex w-full flex-col gap-2 rounded-md border px-3 py-2">
      {dialog.kind === "approval" ? (
        <>
          <p className="text-sm font-medium">{dialog.title}</p>
          {dialog.detail.length > 0 && (
            <pre className="bg-muted text-muted-foreground max-h-32 overflow-auto rounded-sm px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
              {dialog.detail.join("\n")}
            </pre>
          )}
          {change && change.lines.length > 0 && (
            <div className="bg-muted max-h-72 overflow-auto rounded-sm py-1">
              <PatchLines change={change} />
            </div>
          )}
          <p className="text-sm">{dialog.question}</p>
          <fieldset
            ref={options}
            aria-label="Answers"
            className="flex min-w-0 flex-col items-stretch gap-1.5"
            onKeyDown={moveBetweenOptions}
          >
            {dialog.options.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={option.key === "1" ? "default" : "outline"}
                className="h-auto justify-start py-1.5 text-left whitespace-normal"
                disabled={disabled}
                {...{ [OPTION]: "" }}
                onClick={(event) => pick(option.key, event)}
              >
                {option.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="justify-start" disabled={disabled} onClick={(event) => pick("stop", event)}>
              Stop the agent
            </Button>
          </fieldset>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">The agent asks</p>
          <p className="text-sm">{dialog.question}</p>
          <Button size="sm" variant="outline" className="self-start" onClick={onOpen}>
            Answer in the session
          </Button>
        </>
      )}
      {answer.error && <p className="text-destructive text-xs">{answer.error}</p>}
    </div>
  );
}
