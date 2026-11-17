import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

/** A command or a config entry the user runs or pastes elsewhere, with a button that copies it whole. */
export function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="surface flex items-start gap-2 p-2">
      <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
