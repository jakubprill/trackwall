import { ancestorsOf, type BoardItem, type BoardItemChange, boardApi } from "@trackwall/protocol";
import { Pencil } from "lucide-react";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorCode, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { conflictNotice, planSave, shownText, type TextDraft, withoutFields } from "@/lib/item-edit";
import { useAction } from "@/lib/use-action";
import { TicketLink } from "./TicketLink.tsx";

/**
 * An item's text in the right column of Plan (ADR-215): read first, with where it sits in its project, its title, its
 * notes as Markdown and its ticket; "Edit" turns the three into fields and "Save" or "Cancel" turns them back. The notes
 * are formatted like an agent's answer (no raw HTML, no diagrams), since an agent may have written them. The form keeps the
 * item as it was when "Edit" was pressed and saves only the fields the user changed, on the version it shows (ADR-232,
 * `lib/item-edit.ts`), so an agent's notes written meanwhile are never replaced by a stale copy of them.
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
  /** The item as it was when the edit started; `null` while reading. */
  const [base, setBase] = useState<BoardItem | null>(null);
  const save = useAction(
    (change: BoardItemChange, expectedUpdatedAt: string) =>
      post(conn, boardApi.update, { item: item.id, ...change, expectedUpdatedAt }).catch((err: unknown) => {
        // The board here is behind the daemon's: read it again, so the form shows what changed, in plain words.
        if (errorCode(err) !== "item_changed") throw err;
        onChanged();
        throw new Error("The item changed meanwhile, so nothing was saved. Check the text and save again.");
      }),
    () => {
      setBase(null);
      onChanged();
    },
  );
  if (base !== null) {
    return (
      <ItemTextForm
        base={base}
        current={item}
        pending={save.pending}
        error={save.error}
        onSave={save.run}
        onRebase={() => setBase(item)}
        onCancel={() => setBase(null)}
      />
    );
  }
  const above = ancestorsOf(items, item);
  return (
    <div className="flex flex-col gap-2">
      {above.length > 0 && <p className="text-muted-foreground truncate text-xs">{above.map((it) => it.title).join(" › ")} ›</p>}
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-lg font-medium break-words">{item.title}</h3>
        <Button variant="ghost" size="sm" onClick={() => setBase(item)}>
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

/**
 * Title, notes and link as fields. A field the user has not typed into follows the board; when the user and someone else
 * both changed one, Save waits: "Use theirs" drops the user's text of those fields, "Keep mine" builds the edit on the
 * item as it is now, so the save replaces the other text knowingly.
 */
function ItemTextForm({
  base,
  current,
  pending,
  error,
  onSave,
  onRebase,
  onCancel,
}: {
  base: BoardItem;
  current: BoardItem;
  pending: boolean;
  error: string | undefined;
  onSave: (change: BoardItemChange, expectedUpdatedAt: string) => void;
  /** Builds the edit on `current` from now on. */
  onRebase: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TextDraft>({});
  const shown = shownText(draft, current);
  const plan = planSave(base, current, draft);
  const type = (field: keyof TextDraft) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setDraft((typed) => ({ ...typed, [field]: value }));
  };
  return (
    <form
      aria-label="Edit the item"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (plan.kind === "save") onSave(plan.change, plan.expectedUpdatedAt);
      }}
    >
      {plan.kind === "conflict" && (
        <div role="alert" className="border-warning/40 bg-warning/10 flex flex-col gap-2 rounded-md border p-2 text-sm">
          <p>{conflictNotice(plan.fields)} Save waits for your choice.</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => setDraft(withoutFields(draft, plan.fields))}>
              Use theirs
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onRebase}>
              Keep mine
            </Button>
          </div>
        </div>
      )}
      <Input aria-label="Title" value={shown.title} readOnly={pending} onChange={type("title")} />
      <Textarea
        aria-label="Plan and notes"
        placeholder="The plan, notes, what done means (Markdown)"
        value={shown.body}
        readOnly={pending}
        onChange={type("body")}
        rows={10}
      />
      <Input
        aria-label="Link to the ticket"
        placeholder="Link to the ticket, e.g. https://…"
        value={shown.link}
        readOnly={pending}
        onChange={type("link")}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || plan.kind !== "save"}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {plan.kind === "no_title" && <p className="text-muted-foreground text-sm">An item needs a title.</p>}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
    </form>
  );
}
