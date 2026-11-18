import { CircleCheck, ListChecks } from "lucide-react";
import { Fragment } from "react";
import { getStartedEntry } from "@/lib/get-started";
import { SETTINGS_CATEGORIES, SETTINGS_GROUP_LABELS, type SettingsCategory, type SettingsGroup } from "@/lib/settings-categories";
import { cn } from "@/lib/utils";

/**
 * The list of Settings categories (ADR-102) in its three groups (ADR-262), drawn so that they read apart (ADR-268):
 * "Get started" is a framed entry with an icon and a line on what is left to do, and "Settings" and "Reports" each
 * start after a rule with a caption. In a narrow view the list is one row of entries without captions.
 */
export function SettingsNav({
  current,
  openSteps,
  onSelect,
}: {
  current: SettingsCategory;
  /** The open steps of "Get started" from the doctor's last run, `null` while it never ran. */
  openSteps: number | null;
  onSelect: (category: SettingsCategory) => void;
}) {
  return (
    <nav aria-label="Settings categories" className="flex shrink-0 gap-1 overflow-x-auto @3xl:w-48 @3xl:flex-col">
      {SETTINGS_CATEGORIES.map((c, i) => (
        <Fragment key={c.id}>
          <GroupCaption group={c.group} previous={SETTINGS_CATEGORIES[i - 1]?.group} />
          {c.id === "get-started" ? (
            <GetStartedEntry label={c.label} current={c.id === current} openSteps={openSteps} onSelect={() => onSelect(c.id)} />
          ) : (
            <button
              type="button"
              aria-current={c.id === current ? "page" : undefined}
              onClick={() => onSelect(c.id)}
              className={cn(
                "shrink-0 rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors",
                c.id === current ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * "Get started" in the list: a frame and an icon say it is a place to go, and the line under its name says what waits
 * there. With steps to do the frame and the line take the warning colour, also while another category is shown.
 */
function GetStartedEntry({
  label,
  current,
  openSteps,
  onSelect,
}: {
  label: string;
  current: boolean;
  openSteps: number | null;
  onSelect: () => void;
}) {
  const entry = getStartedEntry(openSteps);
  const Icon = entry.state === "done" ? CircleCheck : ListChecks;
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-md border px-3 py-2 text-left whitespace-nowrap transition-colors",
        current ? "bg-secondary border-primary/45" : "hover:bg-accent",
        !current && entry.state === "to-do" && "border-warning/55",
      )}
    >
      {/* Only in the column: in the row of a narrow view the entry scrolls sideways with the others, and stays compact. */}
      <Icon className={cn("hidden size-4 shrink-0 @3xl:block", entry.state === "to-do" ? "text-warning" : "text-primary")} aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className={cn("text-xs", entry.state === "to-do" ? "text-warning" : "text-muted-foreground")}>{entry.text}</span>
      </span>
    </button>
  );
}

/** The caption of a group of categories, above its first one after a rule; only in the list on the left, a row of categories has none. */
function GroupCaption({ group, previous }: { group: SettingsGroup; previous: SettingsGroup | undefined }) {
  const label = SETTINGS_GROUP_LABELS[group];
  if (label === null || group === previous) return null;
  return (
    <span className="text-foreground hidden border-t px-3 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase @3xl:mt-3 @3xl:block">
      {label}
    </span>
  );
}
