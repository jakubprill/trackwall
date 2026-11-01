import { DaemonAddressForm } from "@/components/DaemonAddressForm";
import { Surface } from "@/components/Surface";

/**
 * A browser page whose token the daemon refused when it loaded (ADR-161): none came with the address, or it is from
 * another start of the daemon. The user prints the page address where the daemon runs and pastes it.
 */
export function PageTokenForm({ connect }: { connect: (address: string) => Promise<void> }) {
  return (
    <Surface label="Daemon token">
      <div className="p-4">
        <DaemonAddressForm
          connect={connect}
          intro={
            <>
              <p className="text-sm">
                Trackwall did not accept this page's token. It gets a new one every time it starts, and this browser keeps it for this
                address until then.
              </p>
              <p className="text-muted-foreground text-sm">
                Where Trackwall runs, for example in the dev container's terminal, print its address with{" "}
                <code className="font-mono">trackwall-daemon address</code> (from source:{" "}
                <code className="font-mono">bun packages/daemon/src/main.ts address</code>) and paste it here.
              </p>
            </>
          }
        />
      </div>
    </Surface>
  );
}
