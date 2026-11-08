import { viewerApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * Viewer access for the VS Code extension (ADR-221): off by default; on, the daemon writes a read-only token the extension
 * reads, which shows the sessions and changes nothing.
 */
export function VsCodeExtensionSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, viewerApi.state, {}), [conn]);
  const state = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(enabled: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, viewerApi.setEnabled, { enabled });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      state.reload();
      setBusy(false);
    }
  }

  const data = state.data;
  return (
    <Surface label="VS Code extension">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          The Trackwall extension for VS Code shows your sessions in VS Code's status bar and side bar while you read other code, and opens
          one in Trackwall when you click it. It only reads: it cannot start, stop or answer a session.
        </p>
        {state.error && <ErrorWithRetry message={state.error} onRetry={state.reload} />}
        {!data && !state.error && <Loading />}
        {data && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary size-4 shrink-0"
              checked={data.enabled}
              disabled={busy}
              onChange={(e) => void change(e.target.checked)}
            />
            Let the VS Code extension see the sessions
          </label>
        )}
        {data?.enabled && (
          <p className="text-muted-foreground text-xs break-all">
            The extension reads its read-only token from {data.file}. Turning this off makes the token stop working at once.
          </p>
        )}
        {error && <p className="text-destructive text-xs break-words">{error}</p>}
      </div>
    </Surface>
  );
}
