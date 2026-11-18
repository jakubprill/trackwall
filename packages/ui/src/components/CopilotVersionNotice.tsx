import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { copilotVersionNotice, readNoticeHiddenFor, saveNoticeHiddenFor } from "@/lib/copilot-version-notice";
import { useCopilotCliVersion } from "@/lib/use-copilot-cli-version";

/** Strip above the views while sessions start a Copilot CLI Trackwall is not tested with (ADR-274). */
export function CopilotVersionNotice({ conn, onDiagnostics }: { conn: Connection; onDiagnostics: () => void }) {
  const found = useCopilotCliVersion(conn).data;
  const [hiddenFor, setHiddenFor] = useState(() => readNoticeHiddenFor(() => window.localStorage));
  const text = found ? copilotVersionNotice(found, hiddenFor) : null;
  if (!found || found.relation === "unknown" || text === null) return null;
  const { version } = found;
  const hide = () => {
    setHiddenFor(version);
    saveNoticeHiddenFor(() => window.localStorage, version);
  };
  return (
    <div className="bg-warning/10 flex items-center gap-3 border-b px-4 py-2">
      <p className="min-w-0 flex-1 text-sm">{text}</p>
      <Button variant="outline" size="sm" onClick={onDiagnostics}>
        Diagnostics
      </Button>
      <Button variant="ghost" size="sm" onClick={hide}>
        Hide
      </Button>
    </div>
  );
}
