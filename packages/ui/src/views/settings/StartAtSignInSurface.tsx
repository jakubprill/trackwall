import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { errorMessage } from "@/lib/api";
import { inDesktopShell } from "@/lib/app-window";
import { autostartEnabled, setAutostart } from "@/lib/autostart";
import { currentRun } from "@/lib/background-run";
import { IS_MAC } from "@/lib/platform";
import { useRemote } from "@/lib/use-remote";

const SIGN_IN = IS_MAC ? "log in to your Mac" : "sign in to Windows";

/** Starting Trackwall at sign-in (ADR-65), switched by the desktop shell; the system's own start entry holds it. */
export function StartAtSignInSurface() {
  return (
    <Surface label="Start at sign-in">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Trackwall starts hidden in the tray when you {SIGN_IN}, so the daemon, your repos and the notifications are ready before you open
          it.
        </p>
        {inDesktopShell() ? <StartAtSignInSwitch /> : <p className="text-sm">The desktop app starts at sign-in, not the browser.</p>}
      </div>
    </Surface>
  );
}

function StartAtSignInSwitch() {
  const load = useCallback(() => autostartEnabled(), []);
  const remote = useRemote(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // What the system answered to a change, shown until a read sent after it lands, so the box does not jump back.
  const [answer, setAnswer] = useState<{ run: boolean; afterLoad: number }>();
  const enabled = currentRun(answer, remote);

  async function change(wanted: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const now = await setAutostart(wanted);
      setAnswer({ run: now, afterLoad: remote.sentLoads() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // The system's entry is the record: read it again, also after a refusal.
      remote.reload();
      setBusy(false);
    }
  }

  if (remote.error !== undefined) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (enabled == null) return <Loading />;
  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary size-4 shrink-0"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void change(e.target.checked)}
        />
        Start Trackwall when I sign in
      </label>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
    </>
  );
}
