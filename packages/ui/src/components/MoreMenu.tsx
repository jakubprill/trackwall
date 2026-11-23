import { Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A "More" button and the menu under it (ADR-272): a column of buttons with their names, for what a header does less
 * often. The menu lies over what is under it, so nothing moves or resizes. It closes on Escape (the keyboard goes back
 * to the button), on a click outside it and when the caller's action says so (`close`). Hidden rather than unmounted,
 * so that an action still running when the menu closes shows its error when it opens again.
 */
export function MoreMenu({
  label,
  iconOnly = false,
  children,
}: {
  /** What the menu holds, for a screen reader and the button's tooltip. */
  label: string;
  /** In a narrow header, such as the one of a list; the label is then the button's name. */
  iconOnly?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // In the capture phase, since a terminal under the menu keeps its pointer events to itself.
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);
  return (
    <fieldset
      ref={root}
      aria-label={label}
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        setOpen(false);
        button.current?.focus();
      }}
    >
      <Button
        ref={button}
        variant={iconOnly ? "ghost" : "outline"}
        size={iconOnly ? "icon" : "sm"}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={iconOnly ? label : undefined}
        title={label}
      >
        <Ellipsis /> {!iconOnly && "More"}
      </Button>
      <div
        hidden={!open}
        className="bg-overlay absolute top-full right-0 z-10 mt-1 flex w-max max-w-xs flex-col items-stretch gap-1 rounded-md border p-1 shadow-lg *:justify-start"
      >
        {children(() => setOpen(false))}
      </div>
    </fieldset>
  );
}
