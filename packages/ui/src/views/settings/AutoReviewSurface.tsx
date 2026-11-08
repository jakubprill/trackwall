import { type AutoReviewSettings, workspaceApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * The automatic review (ADR-182) and the check against the repo's rules (ADR-234): whether a task's changes get them as
 * soon as its agent reports its result. Off by default, because every run costs model credits; "Review" and "Check
 * rules" in a task's "Changes" tab work either way.
 */
export function AutoReviewSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(next: AutoReviewSettings) {
    setBusy(true);
    setError(undefined);
    try {
      await post(conn, workspaceApi.setAutoReview, next);
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
          tab, or on its own when you turn it on here. The rules check compares the changes with the repo's AGENTS.md, CLAUDE.md, Copilot
          instruction files and ADRs as they were before the task, and reports only a written rule the changes break.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4 shrink-0"
                checked={data.autoReview.afterReport}
                disabled={busy}
                onChange={(e) => void change({ ...data.autoReview, afterReport: e.target.checked })}
              />
              Review a task's changes when its agent reports its result
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4 shrink-0"
                checked={data.autoReview.rulesAfterReport}
                disabled={busy}
                onChange={(e) => void change({ ...data.autoReview, rulesAfterReport: e.target.checked })}
              />
              Check a task's changes against the repo's rules when its agent reports its result
            </label>
          </>
        )}
        {data?.autoReviewProblem && <p className="text-destructive text-xs break-words">{data.autoReviewProblem}</p>}
        {error && <p className="text-destructive text-xs break-words">{error}</p>}
      </div>
    </Surface>
  );
}
