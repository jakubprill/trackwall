import { REJECTION_REASON_MAX } from "@trackwall/protocol";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * “Reject…” of a task proposal (ADR-55): the first click asks for a reason, which the session that proposed the task
 * gets from `wait_for_session`, so it can propose it differently. The reason is optional; the second click rejects.
 */
export function ProposalReject({ title, disabled, onReject }: { title: string; disabled: boolean; onReject: (reason: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  if (!asking)
    return (
      <Button variant="outline" size="sm" onClick={() => setAsking(true)} disabled={disabled}>
        <X /> Reject…
      </Button>
    );
  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onReject(reason);
      }}
    >
      <Input
        autoFocus
        aria-label={`Why you reject “${title}”`}
        placeholder="Why? The session that proposed it gets this (optional)"
        value={reason}
        maxLength={REJECTION_REASON_MAX}
        onChange={(e) => setReason(e.target.value)}
        className="h-8 min-w-48 flex-1"
      />
      <Button type="submit" variant="destructive" size="sm" disabled={disabled}>
        Reject
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={disabled}>
        Cancel
      </Button>
    </form>
  );
}
