import { type FormEvent, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { remoteDaemonPort, switchToOwnDaemon, switchToRemoteDaemon } from "@/lib/remote-daemon";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * Where the desktop app's daemon runs (ADR-130): its own, started next to the app, or a remote one, for example in a
 * dev container, reached through a port forwarded to this computer. Both switches restart the app. Tauri window only.
 */
export function RemoteDaemonForm() {
  const load = useCallback(() => remoteDaemonPort(), []);
  const port = useRemote(load);
  if (port.error !== undefined) return <ErrorWithRetry message={port.error} onRetry={port.reload} />;
  if (port.data === undefined) return <Loading />;
  return port.data === null ? <ConnectRemote intro={OWN_DAEMON} /> : <ConnectedRemote port={port.data} />;
}

const OWN_DAEMON =
  "The app runs its own daemon on this computer. To use Trackwall running in a dev container instead, paste the address it opens with, including its token. The app then restarts, stops its own daemon and its sessions, and connects there.";

const NEW_TOKEN = "Paste the address with the daemon's current token; the app restarts and connects again.";

/** Nothing follows a switch in this window: the app restarts. */
const RESTARTS = () => {};

function ConnectRemote({ intro }: { intro: string }) {
  const [address, setAddress] = useState("");
  const connect = useAction(switchToRemoteDaemon, RESTARTS);

  function submit(event: FormEvent) {
    event.preventDefault();
    connect.run(address);
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">{intro}</p>
      <div className="flex gap-2">
        <Input
          aria-label="Address of the daemon"
          placeholder="http://127.0.0.1:7700/#token=…"
          className="font-mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={connect.pending}
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="outline" disabled={connect.pending || address.trim() === ""}>
          {connect.pending ? "Connecting…" : "Connect"}
        </Button>
      </div>
      {connect.error && <p className="text-destructive text-xs break-words">{connect.error}</p>}
    </form>
  );
}

function ConnectedRemote({ port }: { port: number }) {
  const ownDaemon = useAction(switchToOwnDaemon, RESTARTS);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        The app uses the daemon at <span className="font-mono">127.0.0.1:{port}</span>, for example in a dev container. It neither starts
        nor stops it: quitting the app leaves it running.
      </p>
      <p className="text-muted-foreground text-sm">
        That daemon gets a new token every time it starts; after a restart, paste its new address here.
      </p>
      <div className="flex flex-wrap gap-2">
        <ReconnectWithNewAddress />
        <Button variant="outline" size="sm" disabled={ownDaemon.pending} onClick={() => ownDaemon.run()}>
          Use this app's own daemon
        </Button>
      </div>
      {ownDaemon.error && <p className="text-destructive text-xs break-words">{ownDaemon.error}</p>}
    </div>
  );
}

function ReconnectWithNewAddress() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Paste a new address
      </Button>
    );
  }
  return (
    <div className="w-full">
      <ConnectRemote intro={NEW_TOKEN} />
    </div>
  );
}
