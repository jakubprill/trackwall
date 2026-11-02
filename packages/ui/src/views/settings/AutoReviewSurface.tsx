import { workspaceApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * The automatic review (ADR-182): whether a task's changes get Copilot CLI's review as soon as its agent reports its
 * result. Off by default, because every review costs model credits; "Review" in a task's "Changes" tab works either way.
 */
export function AutoReviewSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(afterReport: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.setAutoReview, { afterReport });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      settings.reload();
      setBusy(false);
    }
  }

  const data = settings.data;
  return (
    <Surface label="Automatic review">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Copilot CLI reviews a task's changes and you pick the findings to send to the agent as review comments. The reviewer only reads:
          it cannot run commands or change files. Each review costs model credits, so it runs when you click Review in the task's Changes
          tab, or on its own when you turn it on here.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary size-4 shrink-0"
              checked={data.autoReview.afterReport}
              disabled={busy}
              onChange={(e) => void change(e.target.checked)}
            />
            Review a task's changes when its agent reports its result
          </label>
        )}
        {data?.autoReviewProblem && <p className="text-destructive text-xs break-words">{data.autoReviewProblem}</p>}
        {error && <p className="text-destructive text-xs break-words">{error}</p>}
      </div>
    </Surface>
  );
}
