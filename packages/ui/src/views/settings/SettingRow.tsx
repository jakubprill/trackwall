import { ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";
import type { SettingValue } from "@/lib/setting-rows";
import { cn } from "@/lib/utils";

const VALUE_CLASS: Record<SettingValue["state"], string> = {
  default: "text-muted-foreground",
  changed: "text-foreground",
  problem: "text-destructive",
};

/**
 * A setting as a folded row (ADR-263): its name, what it does in one sentence and its value now, with a dot before a
 * value the user changed; a click shows its form under it. The form is mounted only while the row is open, so a folded
 * setting asks the daemon for nothing.
 */
export function SettingRow({
  title,
  what,
  value,
  open,
  onToggle,
  children,
}: {
  title: string;
  what: string;
  value: SettingValue | null;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={formId}
        onClick={onToggle}
        className="hover:bg-accent/50 flex w-full gap-2 px-3 py-2.5 text-left transition-colors"
      >
        <ChevronRight className={cn("text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-sm font-medium">{title}</span>
            {value && (
              <span className={cn("flex max-w-full min-w-0 items-baseline gap-1.5 font-mono text-xs", VALUE_CLASS[value.state])}>
                {value.state === "changed" && (
                  <span role="img" aria-label="Changed" className="bg-primary size-1.5 shrink-0 self-center rounded-full" />
                )}
                <span className="truncate" title={value.text}>
                  {value.text}
                </span>
              </span>
            )}
          </span>
          <span className="text-muted-foreground text-xs">{what}</span>
        </span>
      </button>
      {open && (
        <div id={formId} className="-mt-2 pl-5">
          {children}
        </div>
      )}
    </div>
  );
}
