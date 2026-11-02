import type { MessageAttachment } from "@trackwall/protocol";
import { FileText, Image, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { attachmentOf, attachmentsProblem } from "@/lib/attachments";

/** The attachments of the message being written: files from the picker or a paste, and why one was not taken. */
export function useMessageAttachments() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [problem, setProblem] = useState<string>();
  const add = async (files: readonly File[]) => {
    const read = await Promise.all(
      files.map(async (f) => attachmentOf({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const taken = read.filter((a): a is MessageAttachment => !("problem" in a));
    const next = [...attachments, ...taken];
    const tooMany = attachmentsProblem(next);
    const refused = read.find((a) => "problem" in a);
    setProblem(tooMany ?? (refused && "problem" in refused ? refused.problem : undefined));
    if (tooMany === undefined) setAttachments(next);
  };
  return {
    attachments,
    problem,
    add,
    remove: (index: number) => setAttachments(attachments.filter((_, i) => i !== index)),
    clear: () => {
      setAttachments([]);
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

/** The attachments as chips with their names, each with a button that takes it off. */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly MessageAttachment[];
  onRemove: (index: number) => void;
}) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {attachments.map((attachment, i) => {
        const Icon = attachment.kind === "image" ? Image : FileText;
        return (
          <li
            key={`${i}:${attachment.name}`}
            className="bg-secondary flex max-w-60 items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 text-xs"
          >
            <Icon className="text-primary size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{attachment.name}</span>
            <button
              type="button"
              aria-label={`Remove ${attachment.name}`}
              className="text-muted-foreground hover:text-foreground rounded p-0.5"
              onClick={() => onRemove(i)}
            >
              <X className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
