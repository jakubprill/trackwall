import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { useAction } from "@/lib/use-action";

/** "Open" for a ready service at its `link` (`serviceLink`, ADR-189), with why it did not open beside it. */
export function OpenServiceButton({ conn, link }: { conn: Connection; link: string }) {
  const openLink = useOpenWebLink(conn);
  const open = useAction(
    (url: string) => openLink(url),
    () => {},
  );
  return (
    <span className="flex items-center gap-2">
      {open.error && <span className="text-destructive text-xs">{open.error}</span>}
      <Button variant="outline" size="sm" onClick={() => open.run(link)} title={link}>
        <ExternalLink /> Open
      </Button>
    </span>
  );
}
