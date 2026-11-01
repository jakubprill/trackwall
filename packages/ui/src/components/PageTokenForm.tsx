import { type FormEvent, useState } from "react";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/lib/use-action";

/**
 * A browser page whose token the daemon refused (ADR-161): none came with the address, or it is from before the daemon
 * restarted. The user prints the page address where the daemon runs and pastes it; the page keeps only its token.
 */
export function PageTokenForm({ connect }: { connect: (address: string) => Promise<void> }) {
  const [address, setAddress] = useState("");
  const action = useAction(connect, () => {});

  function submit(event: FormEvent) {
    event.preventDefault();
    action.run(address);
  }

  return (
    <Surface label="Daemon token">
      <form className="flex flex-col gap-3 p-4" onSubmit={submit}>
        <p className="text-sm">
          Trackwall did not accept this page's token. It gets a new one every time it starts, and this browser keeps it for this address
          until then.
        </p>
        <p className="text-muted-foreground text-sm">
          Where Trackwall runs, for example in the dev container's terminal, print its address with{" "}
          <code className="font-mono">trackwall-daemon address</code> (from source:{" "}
          <code className="font-mono">bun packages/daemon/src/main.ts address</code>) and paste it here.
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="Address of the daemon"
            placeholder="http://127.0.0.1:7700/#token=…"
            className="font-mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={action.pending}
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" variant="outline" disabled={action.pending || address.trim() === ""}>
            {action.pending ? "Connecting…" : "Connect"}
          </Button>
        </div>
        {action.error && <p className="text-destructive text-xs break-words">{action.error}</p>}
      </form>
    </Surface>
  );
}
