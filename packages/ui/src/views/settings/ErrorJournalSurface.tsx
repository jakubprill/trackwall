import { errorJournalApi, type TrackwallError } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { errorJournalEntry } from "@/lib/error-journal";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The error journal (ADR-94): Trackwall's own errors with where in its code they came from, so that one seen yesterday can
 * still be looked into. It stays on this computer.
 */
export function ErrorJournalSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, errorJournalApi.errors, {}), [conn]);
  const journal = useRemote(load);
  const clear = useAction(() => post(conn, errorJournalApi.clear, {}), journal.reload);
  const errors = journal.data?.errors;
  return (
    <Surface label="Trackwall errors" meta={errors && errors.length > 0 ? String(errors.length) : undefined}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Errors of Trackwall itself, from the daemon, the desktop app and this window, with the place in Trackwall's code each came from.
          They stay on this computer. Paths, user and computer names, repo names and hosts are replaced before an error is saved.
        </p>
        {journal.error && <ErrorWithRetry message={journal.error} onRetry={journal.reload} />}
        {!errors && !journal.error && <Loading />}
        {errors?.length === 0 && <p className="text-sm">No errors.</p>}
        {errors && errors.length > 0 && (
          <>
            <ul className="flex flex-col gap-3">
              {errors.map((error) => (
                <ErrorEntry key={error.fingerprint} error={error} />
              ))}
            </ul>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" disabled={clear.pending} onClick={() => clear.run()}>
                Clear
              </Button>
              <Button variant="ghost" size="sm" onClick={journal.reload}>
                Refresh
              </Button>
              {clear.error && <p className="text-destructive text-xs">{clear.error}</p>}
            </div>
          </>
        )}
      </div>
    </Surface>
  );
}

function ErrorEntry({ error }: { error: TrackwallError }) {
  const entry = errorJournalEntry(error, new Date());
  return (
    <li className="flex min-w-0 flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm font-medium break-words">{entry.title}</span>
      <span className="text-muted-foreground text-xs">{entry.detail}</span>
      <span className="font-mono text-xs whitespace-pre-wrap break-words">{entry.message}</span>
      {entry.frames.map((frame) => (
        <span key={frame} className="text-muted-foreground font-mono text-xs break-all">
          {frame}
        </span>
      ))}
    </li>
  );
}
