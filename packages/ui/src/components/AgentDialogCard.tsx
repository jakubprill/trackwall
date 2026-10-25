import { type AgentDialog, agentsApi, type DialogAnswer } from "@trackwall/protocol";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/**
 * The agent dialog of a session waiting for you (ADR-66), outside its terminal: what the agent asks, and for an approval
 * Copilot CLI's own options and Stop. A click types the option's key into the session; the daemon types it only while
 * the screen still shows this dialog, so a dialog answered in the terminal meanwhile only says so (`dialog_changed`).
 * Keyed by the dialog's id where it is used, so a new dialog starts without the previous one's error. The texts come
 * from the agent and the repo, so they are plain text. A question is answered in the session terminal (`onOpen`).
 */
export function AgentDialogCard({
  conn,
  session,
  dialog,
  onOpen,
}: {
  conn: Connection;
  session: string;
  dialog: AgentDialog;
  onOpen: () => void;
}) {
  const answer = useAction(
    (key: DialogAnswer) => post(conn, agentsApi.answerDialog, { session, dialog: dialog.id, answer: key }),
    () => {},
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <p className="text-sm font-medium">{dialog.title}</p>
      {dialog.detail.length > 0 && (
        <pre className="bg-muted text-muted-foreground max-h-32 overflow-auto rounded-sm px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
          {dialog.detail.join("\n")}
        </pre>
      )}
      <p className="text-sm">{dialog.question}</p>
      {dialog.kind === "approval" ? (
        <div className="flex flex-col items-stretch gap-1.5">
          {dialog.options.map((option) => (
            <Button
              key={option.key}
              size="sm"
              variant={option.key === "1" ? "default" : "outline"}
              className="h-auto justify-start py-1.5 text-left whitespace-normal"
              disabled={answer.pending}
              onClick={() => answer.run(option.key)}
            >
              {option.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="justify-start" disabled={answer.pending} onClick={() => answer.run("stop")}>
            Stop the agent
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={onOpen}>
          Answer in the session
        </Button>
      )}
      {answer.error && <p className="text-destructive text-xs">{answer.error}</p>}
    </div>
  );
}
