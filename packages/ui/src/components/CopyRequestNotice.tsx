import { agentsApi, type CopyRequest, countLabel, type Session } from "@trackwall/protocol";
import { ClipboardCopy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Connection } from "@/lib/connection";
import { copyRequestPreview, shownCopyRequest } from "@/lib/copy-request";
import { useAction } from "@/lib/use-action";

/**
 * The strip under a running session's header while its agent asks to copy text (ADR-180): what it would copy, and Copy,
 * which writes the clipboard in the click itself, as WKWebView requires, then clears the request; Dismiss only clears it.
 */
export function CopyRequestNotice({ conn, session, onCleared }: { conn: Connection; session: Session | undefined; onCleared: () => void }) {
  const id = session?.id ?? "";
  // `copyText` starts before the first `await`, so still inside the click.
  const take = useAction(async (request: CopyRequest, copy: boolean) => {
    if (copy) await copyText(request.text);
    return post(conn, agentsApi.clearCopyRequest, { session: id, request: request.id });
  }, onCleared);
  const request = shownCopyRequest(session);
  if (!request) return null;
  const { firstLine, lines } = copyRequestPreview(request.text);
  return (
    <section aria-label="Copy request" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <ClipboardCopy className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">The agent asks to copy</span>
      <code className="text-muted-foreground min-w-0 truncate font-mono" title={request.text}>
        {firstLine}
      </code>
      {lines > 1 && <span className="text-muted-foreground shrink-0">{countLabel(lines, { one: "line", other: "lines" })}</span>}
      {take.error && <span className="text-destructive min-w-0 truncate">{take.error}</span>}
      <span className="ml-auto flex shrink-0 gap-1">
        <Button size="sm" onClick={() => take.run(request, true)} disabled={take.pending}>
          <ClipboardCopy /> Copy
        </Button>
        <Button variant="ghost" size="sm" onClick={() => take.run(request, false)} disabled={take.pending} title="Dismiss without copying">
          <X /> Dismiss
        </Button>
      </span>
    </section>
  );
}
