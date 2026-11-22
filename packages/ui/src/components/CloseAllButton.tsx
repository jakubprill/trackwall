import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloseAll } from "@/lib/use-close-all";

/** "Close all" of the tasks ready to close (ADR-282), on the Sessions list and Home's "Needs you"; locked while it runs. */
export function CloseAllButton({ closeAll }: { closeAll: CloseAll }) {
  return (
    <Button
      variant="outline"
      size="sm"
      title="Close every task ready to close, keeping its branch"
      disabled={closeAll.pending}
      onClick={closeAll.run}
    >
      <CheckCheck /> {closeAll.pending ? "Closing…" : "Close all"}
    </Button>
  );
}
