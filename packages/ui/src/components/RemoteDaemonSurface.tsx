import { DevContainerForm } from "@/components/DevContainerForm";
import { HostProjectsFolderForm } from "@/components/HostProjectsFolderForm";
import { RemoteDaemonForm } from "@/components/RemoteDaemonForm";
import { Surface } from "@/components/Surface";
import { inDesktopShell } from "@/lib/app-window";

/**
 * Whether the desktop app runs its own daemon or connects to one in a dev container (ADR-130), which it can start itself
 * (ADR-139), and where this computer sees that daemon's projects folder (ADR-131).
 */
export function RemoteDaemonSurface() {
  return (
    <Surface label="Daemon in a container">
      <div className="flex flex-col gap-3 p-4">
        {inDesktopShell() ? (
          <>
            <DevContainerForm />
            <RemoteDaemonForm />
            <HostProjectsFolderForm />
          </>
        ) : (
          <p className="text-sm">
            This page uses the daemon that served it. The desktop app can connect to a daemon in a dev container too.
          </p>
        )}
      </div>
    </Surface>
  );
}
