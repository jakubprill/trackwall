import { errorJournalApi } from "@trackwall/protocol";
import { Check, ClipboardCopy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/**
 * "Copy diagnostics": what a bug report needs, the version, the system, the doctor's checks and Trackwall's errors, with
 * the user's paths and names replaced by the daemon, put on the clipboard to paste into an issue.
 */
export function CopyDiagnostics({ conn }: { conn: Connection }) {
  const [copied, setCopied] = useState(false);
  const copy = useAction(
    () => post(conn, errorJournalApi.diagnostics, {}).then(({ text }) => copyText(text)),
    () => setCopied(true),
  );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={copy.pending}
        onClick={() => {
          setCopied(false);
          copy.run();
        }}
      >
        {copied ? <Check /> : <ClipboardCopy />} {copy.pending ? "Checking…" : "Copy diagnostics"}
      </Button>
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        {copied
          ? "Copied. Paste it into a bug report and read it first: paths, names, hosts and secrets are replaced."
          : "For a bug report: the version, the system, the doctor's checks and these errors, with your paths, names and hosts replaced."}
      </p>
      {copy.error && <p className="text-destructive text-xs">{copy.error}</p>}
    </div>
  );
}
