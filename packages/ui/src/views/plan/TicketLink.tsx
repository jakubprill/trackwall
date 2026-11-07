import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";

/** "Ticket" opening the link of a project or an item in the browser; nothing without a link. */
export function TicketLink({ conn, link }: { conn: Connection; link: string | null }) {
  const openLink = useOpenWebLink(conn);
  if (link === null) return null;
  return (
    <Button variant="outline" size="sm" className="w-fit max-w-full" title={link} onClick={() => void openLink(link)}>
      <span className="truncate">Ticket</span> <ExternalLink />
    </Button>
  );
}
