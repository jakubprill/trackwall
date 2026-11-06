import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage } from "@/lib/api";
import { inDesktopShell } from "@/lib/app-window";
import { currentRun } from "@/lib/background-run";
import { KEEP_SCREEN_ON_CHOICES, type KeepScreenOn, keepScreenOn, setKeepScreenOn } from "@/lib/keep-screen-on";
import { useRemote } from "@/lib/use-remote";

/** Keeping the screen on (ADR-218), held by the desktop shell with the system's own power request. */
export function KeepScreenOnSurface() {
  return (
    <Surface label="Keep the screen on">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Keeps the screen from turning off and locking while you watch agents work. Trackwall asks the system the way a video player does;
          a lock your organisation enforces after a time without input can still lock the screen.
        </p>
        {inDesktopShell() ? (
          <KeepScreenOnChoice />
        ) : (
          <p className="text-sm">Only the desktop app can keep the screen on, not the browser.</p>
        )}
      </div>
    </Surface>
  );
}

function KeepScreenOnChoice() {
  const load = useCallback(() => keepScreenOn(), []);
  const remote = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // What the shell answered to a change, shown until a read sent after it lands, so the choice does not jump back.
  const [answer, setAnswer] = useState<{ run: KeepScreenOn; afterLoad: number }>();
  const setting = currentRun(answer, remote);

  async function change(wanted: KeepScreenOn) {
    setBusy(true);
    setError(undefined);
    try {
      const now = await setKeepScreenOn(wanted);
      setAnswer({ run: now, afterLoad: remote.sentLoads() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      remote.reload();
      setBusy(false);
    }
  }

  if (remote.error !== undefined) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (setting == null) return <Loading />;
  return (
    <>
      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="sr-only">Keep the screen on</legend>
        {KEEP_SCREEN_ON_CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="keep-screen-on"
              className="accent-primary size-4 shrink-0"
              checked={setting === choice.value}
              onChange={() => void change(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <p className="text-muted-foreground text-xs">
        "While agents work" counts a session or task in the middle of its turn, not one waiting for you or one that may be stuck.
      </p>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
    </>
  );
}
