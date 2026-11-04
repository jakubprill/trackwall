import { agentsApi } from "@trackwall/protocol";
import { FileDiff, X } from "lucide-react";
import { useState } from "react";
import type { LineAnnotations } from "@/components/ChangesDiff";
import { diffLineActions } from "@/components/DiffLineActions";
import { PatchLines } from "@/components/PatchLines";
import { ReviewBar } from "@/components/ReviewBar";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { DiffLine } from "@/lib/diff-lines";
import { askAboutLine, type DiffShown, type TurnFile } from "@/lib/diff-panel";
import { fileName } from "@/lib/file-name";
import { useAction } from "@/lib/use-action";
import type { TaskReview } from "@/lib/use-task-review";
import { cn } from "@/lib/utils";

/**
 * The diff panel beside a wide conversation view: the files one agent turn changed as buttons, and the picked file's
 * changes with line numbers, one after another when the turn changed it more than once, each line with its actions
 * (`DiffLineActions`). A task's review comments added here show above the diff with their Send button, as in the
 * "Changes" tab. ✕ closes it; the conversation does not depend on it.
 */
export function ConversationDiffPanel({
  conn,
  session,
  review,
  shown,
  onPick,
  onAsk,
  onClose,
  className,
}: {
  conn: Connection;
  session: string;
  /** The task's review, shared with its "Changes" tab; none for a session without a task. */
  review: TaskReview | undefined;
  shown: DiffShown | null;
  onPick: (path: string) => void;
  /** Puts text in front of the message being written. */
  onAsk: (text: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const [pickedLine, setPickedLine] = useState<string | null>(null);
  const open = useAction(
    (target: { path: string; line: number }) => post(conn, agentsApi.openConversationFile, { session, ...target }),
    () => {},
  );
  // The line "Open in VS Code" was last pressed on: its error shows only there, until another line is picked.
  const [openedLine, setOpenedLine] = useState<string | null>(null);
  // A line is picked in one change of the file, which shows its line again when the turn changed the file twice.
  const annotationsFor = (tool: string) =>
    diffLineActions({
      current: tool === shown?.current,
      change: tool,
      picked: pickedLine,
      onPick: (key) => {
        setPickedLine(key);
        setOpenedLine(null);
      },
      review,
      onOpen: (key, anchor) => {
        setOpenedLine(key);
        open.run({ path: anchor.path, line: anchor.line });
      },
      openError: openedLine !== null && openedLine === pickedLine ? open.error : undefined,
      onAsk: (anchor, line: DiffLine) => {
        onAsk(askAboutLine(anchor, line.text));
        setPickedLine(null);
      },
    });
  return (
    <aside aria-label="Changes of the turn" className={cn("min-h-0 min-w-0 flex-col border-l", className)}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <FileDiff className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="hud-label min-w-0 flex-1 truncate">Changes of the turn</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close the diff" title="Close the diff" onClick={onClose}>
          <X />
        </Button>
      </div>
      {shown ? (
        <>
          {shown.files.length > 1 && (
            <nav aria-label="Files the turn changed" className="flex flex-wrap gap-1.5 border-b px-3 py-2">
              {shown.files.map((file) => (
                <FilePill key={file.path} file={file} picked={file.path === shown.file.path} onPick={() => onPick(file.path)} />
              ))}
            </nav>
          )}
          {review && (
            <div className="border-b px-3 py-2 empty:hidden">
              <ReviewBar review={review} />
            </div>
          )}
          <FileDiffLines file={shown.file} annotationsFor={annotationsFor} />
        </>
      ) : (
        <p className="text-muted-foreground m-auto px-4 text-center text-sm">A file the agent changes shows here with its diff.</p>
      )}
    </aside>
  );
}

function FilePill({ file, picked, onPick }: { file: TurnFile; picked: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      title={file.path}
      onClick={onPick}
      className={cn(
        "max-w-full truncate rounded-full border px-2 py-0.5 font-mono text-xs",
        picked ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {fileName(file.path)} <span className="text-success">+{file.added}</span> <span className="text-destructive">−{file.removed}</span>
    </button>
  );
}

/** The file's changes with line numbers, one after another when the turn changed it more than once. */
function FileDiffLines({ file, annotationsFor }: { file: TurnFile; annotationsFor: (tool: string) => LineAnnotations }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="truncate border-b px-3 py-1.5 font-mono text-xs" title={file.path}>
        {file.path}
      </p>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {file.changes.map(({ tool, change }) => (
          <div key={tool} className="border-b pb-1.5 last:border-b-0">
            <PatchLines change={change} lineNumbers annotations={annotationsFor(tool)} />
          </div>
        ))}
      </div>
    </div>
  );
}
