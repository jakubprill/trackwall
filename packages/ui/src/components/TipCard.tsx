import { BookOpen } from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { IS_MAC } from "@/lib/platform";
import { TIPS, type TipId } from "@/lib/tips";
import { cn } from "@/lib/utils";

/**
 * A tip as it shows in the view, right under the control it explains (ADR-296): in the page's flow rather than over
 * it, so it never covers the prompt or the button the user reaches for next.
 */
export function TipCard({
  tip,
  className,
  docsError,
  onDocs,
  onTurnOff,
  onGotIt,
  ref,
}: {
  tip: TipId;
  /** Where the place puts the card in its layout. */
  className?: string;
  /** Why the documentation page did not open. */
  docsError?: string;
  onDocs: () => void;
  onTurnOff: () => void;
  onGotIt: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const { label, title, text, docs } = TIPS[tip];
  return (
    <section
      ref={ref}
      aria-label={`Tip: ${label}`}
      className={cn("border-primary/40 bg-primary/10 flex flex-col gap-1 rounded-md border px-3 py-2", className)}
    >
      <p className="hud-label">
        Tip <span className="text-primary">{`// ${label}`}</span>
      </p>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-sm">{text(IS_MAC)}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
        {/* The page's title wraps, since a tip is as narrow as its place, down to an approval in Home's details. */}
        <Button variant="ghost" size="sm" className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal" onClick={onDocs}>
          <BookOpen /> {docs.title}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onTurnOff}>
          Turn off tips
        </Button>
        <Button size="sm" onClick={onGotIt}>
          Got it
        </Button>
      </div>
      {docsError && <p className="text-destructive text-xs">{docsError}</p>}
    </section>
  );
}
