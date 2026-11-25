import { StatusLabel } from "@/components/StatusLabel";
import type { RepoActivityItem, RepoActivityTarget } from "@/lib/repo-activity";

/**
 * "In this repo" above the repo's tabs (ADR-103): proposals, sessions, tasks and running mise tasks of the repo, each a
 * button to where its work is. Above the tabs, so it stays in view whichever tab is open.
 */
export function RepoActivityBar({ items, onOpen }: { items: readonly RepoActivityItem[]; onOpen: (target: RepoActivityTarget) => void }) {
  return (
    <section aria-label="In this repo" className="flex flex-wrap items-center gap-2">
      <span className="hud-label mr-1">In this repo</span>
      {items.length === 0 ? (
        <span className="text-muted-foreground text-xs">no sessions, tasks or running mise tasks</span>
      ) : (
        items.map((item) => <RepoActivityButton key={item.key} item={item} onOpen={onOpen} />)
      )}
    </section>
  );
}

/** One item of the repo's work, a button to where it is; also in the removal panel's list of work to end first. */
export function RepoActivityButton({ item, onOpen }: { item: RepoActivityItem; onOpen: (target: RepoActivityTarget) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.open)}
      title={`${item.name}: ${item.status.label}`}
      className="surface hover:border-primary flex max-w-96 min-w-0 items-center gap-2 px-2.5 py-1 text-xs"
    >
      <span className="min-w-0 truncate">{item.name}</span>
      <StatusLabel {...item.status} />
    </button>
  );
}
