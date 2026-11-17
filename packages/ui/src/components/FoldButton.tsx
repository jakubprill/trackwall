import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The button of a part of a form that stays folded until asked for (ADR-266): a chevron, what the part is, and
 * `aria-expanded`. The part itself is rendered by the caller, under the button, while `open`.
 */
export function FoldButton({
  open,
  onOpen,
  className,
  children,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" className={cn("w-fit", className)} aria-expanded={open} onClick={() => onOpen(!open)}>
      {open ? <ChevronDown /> : <ChevronRight />} {children}
    </Button>
  );
}
