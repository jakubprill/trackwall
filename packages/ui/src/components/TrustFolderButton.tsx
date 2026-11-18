import type { TrustedProjectsFolder } from "@trackwall/protocol";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TRUST_FOLDER_EFFECT, trustedFolderMessage } from "@/lib/trust-folder";
import { useAction } from "@/lib/use-action";

/**
 * "Trust folder" (ADR-270): one click instead of editing Copilot CLI's `config.json` by hand, with what the click does
 * said next to the button. After the click it says what was written; an error leaves the button for another try.
 * `trust` sends the request, so the gallery of view states draws the button without a daemon.
 */
export function TrustFolderButton({ trust, onTrusted }: { trust: () => Promise<TrustedProjectsFolder>; onTrusted?: () => void }) {
  const [done, setDone] = useState<TrustedProjectsFolder>();
  const action = useAction(trust, (result) => {
    setDone(result);
    onTrusted?.();
  });
  if (done) return <p className="text-success text-xs break-words">{trustedFolderMessage(done)}</p>;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" onClick={() => action.run()} disabled={action.pending}>
        <ShieldCheck /> Trust folder
      </Button>
      <p className="text-muted-foreground max-w-prose text-xs">{TRUST_FOLDER_EFFECT}</p>
      {action.error && <p className="text-destructive text-xs break-words">{action.error}</p>}
    </div>
  );
}
