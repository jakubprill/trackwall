import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/use-action";

/** "Remove", which asks once more, since the file is gone for good (a routine, a knowledge entry). */
export function RemoveForGood({
  remove,
  disabled,
  onRemoved,
}: {
  remove: () => Promise<unknown>;
  disabled: boolean;
  onRemoved: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const action = useAction(remove, onRemoved);
  if (!asking)
    return (
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setAsking(true)}>
        <Trash2 /> Remove
      </Button>
    );
  return (
    <>
      <Button variant="destructive" size="sm" disabled={disabled || action.pending} onClick={() => action.run()}>
        Remove for good
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep it
      </Button>
      {action.error && <p className="text-destructive text-xs">{action.error}</p>}
    </>
  );
}
