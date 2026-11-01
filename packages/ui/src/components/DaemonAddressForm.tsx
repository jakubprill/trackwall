import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/lib/use-action";

/**
 * A field for the daemon's page address with its token (`http://127.0.0.1:<port>/#token=…`), for the desktop app's remote
 * daemon (ADR-130) and a browser page whose token was refused (ADR-161); `connect` does the rest and rejects with why.
 */
export function DaemonAddressForm({ intro, connect }: { intro: ReactNode; connect: (address: string) => Promise<unknown> }) {
  const [address, setAddress] = useState("");
  const action = useAction(connect, () => {});

  function submit(event: FormEvent) {
    event.preventDefault();
    action.run(address);
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      {intro}
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
  );
}
