import { ancestorsOf, type BoardItem, type BoardItemChange, boardApi } from "@trackwall/protocol";
import { Pencil } from "lucide-react";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { TicketLink } from "./TicketLink.tsx";

/**
 * An item's text in the right column of Plan (ADR-215): read first, with where it sits in its project, its title, its
 * notes as Markdown and its ticket; "Edit" turns the three into fields and "Save" or "Cancel" turns them back. The notes
 * are formatted like an agent's answer (no raw HTML, no diagrams), since an agent may have written them.
 */
export function ItemText({
  conn,
  items,
  item,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  item: BoardItem;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const save = useAction(
    (change: BoardItemChange) => post(conn, boardApi.update, { item: item.id, ...change }),
    () => {
      setEditing(false);
      onChanged();
    },
  );
  if (editing) {
    return <ItemTextForm item={item} pending={save.pending} error={save.error} onSave={save.run} onCancel={() => setEditing(false)} />;
  }
  const above = ancestorsOf(items, item);
  return (
    <div className="flex flex-col gap-2">
      {above.length > 0 && <p className="text-muted-foreground truncate text-xs">{above.map((it) => it.title).join(" › ")} ›</p>}
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-lg font-medium break-words">{item.title}</h3>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          <Pencil /> Edit
        </Button>
      </div>
      <TicketLink conn={conn} link={item.link} />
      {item.body.trim() === "" ? (
        <p className="text-muted-foreground text-sm">No notes yet. Edit to write the plan or what done means.</p>
      ) : (
        <Notes conn={conn} text={item.body} />
      )}
    </div>
  );
}

/** Until the Markdown chunk has loaded, or if it fails, the notes are plain text. */
function Notes({ conn, text }: { conn: Connection; text: string }) {
  const plain = <p className="text-sm whitespace-pre-wrap break-words">{text}</p>;
  return (
    <ErrorBoundary fallback={() => plain}>
      <Suspense fallback={plain}>
        <LazyMarkdown conn={conn} text={text} source="agent" className="text-sm" />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Title, notes and link as fields, saved together. */
function ItemTextForm({
  item,
  pending,
  error,
  onSave,
  onCancel,
}: {
  item: BoardItem;
  pending: boolean;
  error: string | undefined;
  onSave: (change: BoardItemChange) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [link, setLink] = useState(item.link ?? "");
  const change = { title: title.trim(), body, link: link.trim() === "" ? null : link.trim() };
  const changed = change.title !== item.title || change.body !== item.body || change.link !== item.link;
  return (
    <form
      aria-label="Edit the item"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(change);
      }}
    >
      <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea
        aria-label="Plan and notes"
        placeholder="The plan, notes, what done means (Markdown)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
      />
      <Input
        aria-label="Link to the ticket"
        placeholder="Link to the ticket, e.g. https://…"
        value={link}
        onChange={(e) => setLink(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !changed || change.title === ""}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </form>
  );
}
