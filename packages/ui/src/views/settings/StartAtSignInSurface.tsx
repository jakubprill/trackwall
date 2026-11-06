import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { inDesktopShell } from "@/lib/app-window";
import { autostartEnabled, setAutostart } from "@/lib/autostart";
import { IS_MAC } from "@/lib/platform";
import { useShellSetting } from "@/lib/use-shell-setting";

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
  // The system's entry is the record, so the hook reads it again after every change.
  const { remote, value: enabled, busy, error, change } = useShellSetting(autostartEnabled, setAutostart);

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
