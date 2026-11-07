import { boardApi } from "@trackwall/protocol";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { ideaFields } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/** The line that adds an item under `parent`: a project's top level, or with `null` an idea in the inbox. */
export function NewItemLine({
  conn,
  parent,
  label,
  onAdded,
}: {
  conn: Connection;
  parent: string | null;
  label: string;
  onAdded: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const add = useAction(
    (fields: { title: string; body: string }) => post(conn, boardApi.create, { kind: "item", parent, ...fields }),
    (item) => {
      setTitle("");
      onAdded(item.id);
    },
  );
  const fields = ideaFields(title);
  return (
    <>
      <Input
        aria-label={label}
        placeholder={label}
        value={title}
        disabled={add.pending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && fields) add.run(fields);
        }}
      />
      {add.error && <p className="text-destructive text-sm">{add.error}</p>}
    </>
  );
}
