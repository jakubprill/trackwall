import type { AttachmentLabel, MessageAttachment } from "@trackwall/protocol";
import { FileText, Image, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { attachmentOf, attachmentsProblem, sizeProblem } from "@/lib/attachments";

/** The attachments of the message being written: files from the picker or a paste, and why one was not taken. */
export function useMessageAttachments() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [problem, setProblem] = useState<string>();
  // The list as it is now, not as the render that started a read saw it: a paste and a pick that overlap both stay.
  const current = useRef<MessageAttachment[]>([]);
  const set = (next: MessageAttachment[]) => {
    current.current = next;
    setAttachments(next);
  };
  const add = async (files: readonly File[]) => {
    const tooLarge = files.map(sizeProblem).find((p) => p !== undefined);
    if (tooLarge !== undefined) return setProblem(tooLarge);
    const read = await Promise.all(
      files.map(async (f) => attachmentOf({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const taken = read.filter((a): a is MessageAttachment => !("problem" in a));
    const next = [...current.current, ...taken];
    const tooMany = attachmentsProblem(next);
    const refused = read.find((a) => "problem" in a);
    setProblem(tooMany ?? (refused && "problem" in refused ? refused.problem : undefined));
    if (tooMany === undefined) set(next);
  };
  return {
    attachments,
    problem,
    add,
    remove: (index: number) => set(current.current.filter((_, i) => i !== index)),
    clear: () => {
      set([]);
      setProblem(undefined);
    },
  };
}

/** The button that picks files to attach. */
export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Files to attach"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label="Attach files"
        title="Attach images or text files"
        onClick={() => input.current?.click()}
      >
        <Paperclip />
      </Button>
    </>
  );
}

/**
 * Attachments as chips with their kind's icon and name: under a message that went (`label` "Attached"), or in the
 * message box with a button on each that takes it off.
 */
export function AttachmentChips({
  attachments,
  label,
  onRemove,
}: {
  attachments: readonly AttachmentLabel[];
  label: string;
  onRemove?: (index: number) => void;
}) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5 text-xs">
      {attachments.map((attachment, i) => {
        const Icon = attachment.kind === "image" ? Image : FileText;
        return (
          <li
            key={`${i}:${attachment.name}`}
            className={
              onRemove
                ? "bg-secondary flex max-w-60 items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5"
                : "text-muted-foreground flex max-w-60 items-center gap-1 rounded-md border px-1.5 py-0.5"
            }
          >
            <Icon className="text-primary size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{attachment.name}</span>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
                onClick={() => onRemove(i)}
              >
                <X className="size-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
