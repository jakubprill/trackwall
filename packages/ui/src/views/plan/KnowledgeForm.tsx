import { KnowledgeKind, knowledgeApi } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { KIND_LABELS, parseRepos } from "@/lib/knowledge";
import { useAction } from "@/lib/use-action";

/** A new entry typed by the user, approved as written; a name already on the list replaces that entry. */
export function KnowledgeForm({
  conn,
  onWritten,
  onCancel,
}: {
  conn: Connection;
  onWritten: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<KnowledgeKind>("how-to");
  const [repos, setRepos] = useState("");
  const [text, setText] = useState("");
  const write = useAction(
    () => post(conn, knowledgeApi.write, { name: name.trim(), kind, repos: parseRepos(repos), text, evidence: "" }),
    (written) => onWritten(written.name),
  );
  return (
    <form
      aria-label="New knowledge entry"
      className="flex flex-col gap-2 rounded-md border border-dashed p-3"
      onSubmit={(e) => {
        e.preventDefault();
        write.run();
      }}
    >
      <h4 className="hud-label">New entry</h4>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Name"
          placeholder="name, e.g. orders-integration-tests"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-72"
        />
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(KnowledgeKind.parse(e.target.value))}
          className="border-input bg-card h-8 rounded-md border px-2 text-sm"
        >
          {KnowledgeKind.options.map((option) => (
            <option key={option} value={option}>
              {KIND_LABELS[option]}
            </option>
          ))}
        </select>
        <Input
          aria-label="Repos"
          placeholder="repos (empty: whole workspace)"
          value={repos}
          onChange={(e) => setRepos(e.target.value)}
          className="w-64"
        />
      </div>
      <Textarea
        aria-label="Fact"
        placeholder="Integration tests run with mise run test-it; mise run test skips them."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={write.pending || name.trim() === "" || text.trim() === ""}>
          Save
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {write.error && <p className="text-destructive text-xs whitespace-pre-wrap">{write.error}</p>}
    </form>
  );
}
