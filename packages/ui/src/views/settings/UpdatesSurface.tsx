import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { UpdateInstallStatus } from "@/components/UpdateInstallStatus";
import { UpdateOffer } from "@/components/UpdateOffer";
import { Button } from "@/components/ui/button";
import type { AppUpdateHandle } from "@/lib/use-app-update";

/** Updates from GitHub Releases (ADR-53). Without the Tauri window (`trackwall-daemon --ui`) the app is updated by hand. */
export function UpdatesSurface({ handle }: { handle: AppUpdateHandle | undefined }) {
  return (
    <Surface label="Updates">
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Trackwall checks GitHub Releases for a newer version every few hours and installs it when you click. The download is checked
          against the release signing key.
        </p>
        {handle ? <UpdateStatus handle={handle} /> : <p className="text-sm">Updates are installed from the desktop app.</p>}
      </div>
    </Surface>
  );
}

function UpdateStatus({ handle }: { handle: AppUpdateHandle }) {
  const { update, check, install, cancel } = handle;
  const checkButton = (
    <Button variant="outline" size="sm" onClick={check}>
      Check for updates
    </Button>
  );
  switch (update.state) {
    case "idle":
      return checkButton;
    case "checking":
      return <Loading text="Checking for updates…" />;
    case "latest":
      return (
        <>
          <p className="text-sm">Trackwall {update.currentVersion} is the latest version.</p>
          {checkButton}
        </>
      );
    case "available":
    case "waiting":
      return (
        <div className="flex w-full flex-wrap items-center gap-3">
          <UpdateOffer handle={handle} />
        </div>
      );
    case "installing":
      return <UpdateInstallStatus update={update} cancel={cancel} />;
    case "check-failed":
      return (
        <>
          <p className="text-destructive text-sm whitespace-pre-wrap break-words">{update.message}</p>
          {checkButton}
        </>
      );
    case "install-failed":
      return (
        <>
          <p className="text-destructive text-sm whitespace-pre-wrap break-words">{update.message}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => install(update.version)}>
              Try again
            </Button>
            {checkButton}
          </div>
        </>
      );
  }
}
