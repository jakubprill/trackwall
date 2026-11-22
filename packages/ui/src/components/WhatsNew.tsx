import { countLabel, TRACKWALL_RELEASES_URL, type WorkspaceSettings } from "@trackwall/protocol";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { useTips } from "@/lib/tips-controller";
import { useAction } from "@/lib/use-action";
import type { Remote } from "@/lib/use-remote";
import { useWhatsNew } from "@/lib/use-whats-new";
import type { WhatsNewEntry, WhatsNewPlace } from "@/lib/whats-new";

/**
 * Strip above the views after an update (ADR-296): the changes worth a look, each with "Show", which opens the place it
 * lives in and shows its tip there. It goes with "Dismiss" until the next update brings more, and with tips turned off.
 */
export function WhatsNew({
  conn,
  workspace,
  onShow,
}: {
  conn: Connection | undefined;
  /** The workspace settings: a new install, which shows no What's new, has no projects folder yet. */
  workspace: Remote<WorkspaceSettings>;
  onShow: (place: WhatsNewPlace) => void;
}) {
  const { tips, state } = useTips();
  const { entries, dismiss } = useWhatsNew(workspace.data && workspace.data.projectsDir === null);
  if (!conn || !state.on || !entries || entries.length === 0) return null;
  const show = ({ place, tip }: NonNullable<WhatsNewEntry["show"]>) => {
    if (tip) tips?.ask(tip);
    onShow(place);
  };
  return <WhatsNewStrip conn={conn} entries={entries} onShow={show} onDismiss={dismiss} />;
}

/** The strip with its entries, unfolded until "Hide". */
export function WhatsNewStrip({
  conn,
  entries,
  onShow,
  onDismiss,
}: {
  conn: Connection;
  entries: readonly WhatsNewEntry[];
  onShow: (show: NonNullable<WhatsNewEntry["show"]>) => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const openLink = useOpenWebLink(conn);
  const notes = useAction(
    () => openLink(TRACKWALL_RELEASES_URL),
    () => {},
  );
  return (
    <section aria-label="What's new" className="bg-primary/10 @container border-b px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-medium">What's new.</span>{" "}
          <span className="text-muted-foreground">
            {countLabel(entries.length, { one: "change", other: "changes" })} worth a look, each shown where it lives.
          </span>
        </p>
        <Button variant="ghost" size="sm" onClick={notes.run}>
          Release notes <ExternalLink />
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide" : "Show"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {notes.error && <p className="text-destructive text-xs">{notes.error}</p>}
      {expanded && (
        // At most about two rows of a wide window, so that a small window keeps room for its view.
        <ul className="mt-2 grid max-h-64 gap-2 overflow-y-auto @2xl:grid-cols-2 @5xl:grid-cols-3">
          {entries.map((entry) => (
            <WhatsNewItem key={entry.id} entry={entry} onShow={onShow} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WhatsNewItem({
  entry: { title, text, show },
  onShow,
}: {
  entry: WhatsNewEntry;
  onShow: (show: NonNullable<WhatsNewEntry["show"]>) => void;
}) {
  return (
    <li className="bg-card flex items-start gap-3 rounded-md border px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{text}</span>
      </span>
      {show && (
        // "Show" names its change for a screen reader, as every entry has one.
        <Button variant="outline" size="sm" aria-label={`Show ${title}`} onClick={() => onShow(show)}>
          Show
        </Button>
      )}
    </li>
  );
}
