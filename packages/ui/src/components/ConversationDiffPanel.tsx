import { FileDiff, X } from "lucide-react";
import { PatchLines } from "@/components/PatchLines";
import { Button } from "@/components/ui/button";
import type { DiffShown, TurnFile } from "@/lib/diff-panel";
import { fileName } from "@/lib/file-name";
import { cn } from "@/lib/utils";

/**
 * The diff panel beside a wide conversation view: the files one agent turn changed as buttons, and the picked file's
 * changes with line numbers, one after another when the turn changed it more than once. ✕ closes it; the conversation
 * does not depend on it.
 */
export function ConversationDiffPanel({
  shown,
  onPick,
  onClose,
  className,
}: {
  shown: DiffShown | null;
  onPick: (path: string) => void;
  onClose: () => void;
  className?: string;
}) {
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
          <FileDiffLines file={shown.file} />
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
function FileDiffLines({ file }: { file: TurnFile }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="truncate border-b px-3 py-1.5 font-mono text-xs" title={file.path}>
        {file.path}
      </p>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {file.changes.map(({ tool, change }) => (
          <div key={tool} className="border-b pb-1.5 last:border-b-0">
            <PatchLines change={change} lineNumbers />
          </div>
        ))}
      </div>
    </div>
  );
}
