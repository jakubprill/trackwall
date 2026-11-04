import type { Service } from "@trackwall/protocol";
import { ExternalLink } from "lucide-react";
import { useContext } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { DaemonPlaceContext, useOpenWebLink } from "@/lib/desktop";
import { serviceLink } from "@/lib/service-state";
import { useAction } from "@/lib/use-action";

/**
 * "Open" for a ready service (ADR-189): the service in the browser, through the daemon's service proxy when it runs in
 * a dev container. Nothing while the service is not ready or nothing on this computer can reach it.
 */
export function OpenServiceButton({ conn, service }: { conn: Connection; service: Service | null }) {
  const link = serviceLink(useContext(DaemonPlaceContext), service);
  const openLink = useOpenWebLink(conn);
  const open = useAction(
    (url: string) => openLink(url),
    () => {},
  );
  if (!link) return null;
  return (
    <span className="flex items-center gap-2">
      {open.error && <span className="text-destructive text-xs">{open.error}</span>}
      <Button variant="outline" size="sm" onClick={() => open.run(link)} title={link}>
        <ExternalLink /> Open
      </Button>
    </span>
  );
}
