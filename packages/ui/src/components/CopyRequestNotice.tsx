import { agentsApi, type CopyRequest, countLabel, type Session } from "@trackwall/protocol";
import { ClipboardCopy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Connection } from "@/lib/connection";
import { COPY_REQUEST_HOLD_MS, copyRequestPreview } from "@/lib/copy-request";
import { useAction } from "@/lib/use-action";

/**
 * The strip under a running session's header while its agent asks to copy text (ADR-180; the daemon sends the request
 * only while the session runs): what it would copy, and Copy, which writes the clipboard in the click itself, as
 * WKWebView requires, then clears the request; Dismiss only clears it. Copy is ready only `COPY_REQUEST_HOLD_MS` after
 * the request appears or changes.
 */
export function CopyRequestNotice({ conn, session, onCleared }: { conn: Connection; session: Session; onCleared: () => void }) {
  const request = session.copyRequest;
  const [readyFor, setReadyFor] = useState<string>();
  useEffect(() => {
    if (request === null) return;
    const timer = setTimeout(() => setReadyFor(request.id), COPY_REQUEST_HOLD_MS);
    return () => clearTimeout(timer);
  }, [request]);
  // `copyText` starts before the first `await`, so still inside the click.
  const take = useAction(async (taken: CopyRequest, copy: boolean) => {
    if (copy) await copyText(taken.text);
    return post(conn, agentsApi.clearCopyRequest, { session: session.id, request: taken.id });
  }, onCleared);
  if (request === null) return null;
  const { firstLine, lines, characters } = copyRequestPreview(request.text);
  const counts = [
    lines > 1 ? countLabel(lines, { one: "line", other: "lines" }) : undefined,
    countLabel(characters, { one: "character", other: "characters" }),
  ];
  return (
    <section aria-label="Copy request" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <ClipboardCopy className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">The agent asks to copy</span>
      <code className="text-muted-foreground min-w-0 truncate font-mono" title={request.text}>
        {firstLine}
      </code>
      <span className="text-muted-foreground shrink-0">{counts.filter((count) => count !== undefined).join(" · ")}</span>
      {take.error && <span className="text-destructive min-w-0 truncate">{take.error}</span>}
      <span className="ml-auto flex shrink-0 gap-1">
        <Button size="sm" onClick={() => take.run(request, true)} disabled={take.pending || readyFor !== request.id}>
          <ClipboardCopy /> Copy
        </Button>
        <Button variant="ghost" size="sm" onClick={() => take.run(request, false)} disabled={take.pending} title="Dismiss without copying">
          <X /> Dismiss
        </Button>
      </span>
    </section>
  );
}
