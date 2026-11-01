import { KnowledgeKind, type KnowledgeListEntry, knowledgeApi, trackwallDirLabel } from "@trackwall/protocol";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { RemoveForGood } from "@/components/RemoveForGood";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { KIND_LABELS, knowledgeOrder, knowledgeWarnings, mayBelongInRepo, parseRepos } from "@/lib/knowledge";
import { reloadOnRefusal } from "@/lib/reload-on-refusal";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

const KNOWLEDGE_POLL_MS = 10_000;

/**
 * Workspace knowledge in Plan (ADR-170): short facts about the user's repos that every later session in those repos reads
 * in its instructions. An agent's proposal shows first, open, with its evidence and what to check, and counts only once
 * the user approves that version; the user's own entries, written here, count as written.
 */
export function KnowledgeList({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, knowledgeApi.list, {}), [conn]);
  // A proposal an agent writes while Plan is open shows within the poll.
  const list = useRemote(load, { pollMs: KNOWLEDGE_POLL_MS });
  if (list.error) return <ErrorWithRetry message={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { entries, problems } = list.data;
  return (
    <section aria-label="Workspace knowledge" className="flex max-w-3xl flex-col gap-3 p-4">
      <h3 className="hud-label">Workspace knowledge</h3>
      <p className="text-muted-foreground max-w-prose text-xs">
        Facts about your repos that agents read at the start of every session in those repos: how to run or test something, links between
        repos the graph does not show, exceptions to a rule, pitfalls. Agents propose them; only the version you approve reaches a session.
      </p>
      {knowledgeOrder(entries).map((entry) => (
        <KnowledgeRow key={`${entry.name}-${entry.digest}`} conn={conn} entry={entry} onChanged={list.reload} />
      ))}
      {problems.map((problem) => (
        <p key={problem.file} className="text-destructive text-xs">
          <span className="font-mono">{problem.file}</span>: {problem.message}
        </p>
      ))}
      <KnowledgeForm conn={conn} onWritten={list.reload} />
    </section>
  );
}

function KnowledgeRow({ conn, entry, onChanged }: { conn: Connection; entry: KnowledgeListEntry; onChanged: () => void }) {
  const approve = useAction(
    () => reloadOnRefusal(post(conn, knowledgeApi.approve, { name: entry.name, digest: entry.digest }), onChanged),
    onChanged,
  );
  const warnings = entry.approved ? [] : knowledgeWarnings(entry);
  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{KIND_LABELS[entry.kind]}</Badge>
        <span className="text-muted-foreground font-mono text-xs">
          {entry.repos.length === 0 ? "whole workspace" : entry.repos.join(", ")}
        </span>
        {entry.writtenBy.kind === "agent" && <span className="text-muted-foreground text-xs">proposed by an agent</span>}
        {!entry.approved && <Badge>needs your approval</Badge>}
      </div>
      <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
      {!entry.approved && entry.evidence !== "" && (
        <p className="text-muted-foreground text-xs whitespace-pre-wrap">
          <span className="hud-label">Evidence</span> {entry.evidence}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-warning text-xs">
          {warning}
        </p>
      ))}
      {!entry.approved && mayBelongInRepo(entry) && (
        <p className="text-muted-foreground text-xs">
          This is about one repo. If its team would agree, it may belong in that repo's own agent instructions instead, where everyone reads
          it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!entry.approved && (
          <Button size="sm" onClick={() => approve.run()} disabled={approve.pending}>
            <Check /> Approve this version
          </Button>
        )}
        <span className="text-muted-foreground font-mono text-xs">{`${trackwallDirLabel("knowledge")}/${entry.name}.md`}</span>
        <RemoveForGood
          remove={() => post(conn, knowledgeApi.remove, { name: entry.name })}
          disabled={approve.pending}
          onRemoved={onChanged}
        />
      </div>
      {approve.error && <p className="text-destructive text-xs whitespace-pre-wrap">{approve.error}</p>}
    </div>
  );
}

/** A new entry typed by the user, approved as written; a name already on the list replaces that entry. */
function KnowledgeForm({ conn, onWritten }: { conn: Connection; onWritten: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<KnowledgeKind>("how-to");
  const [repos, setRepos] = useState("");
  const [text, setText] = useState("");
  const write = useAction(
    () => post(conn, knowledgeApi.write, { name: name.trim(), kind, repos: parseRepos(repos), text, evidence: "" }),
    () => {
      setName("");
      setRepos("");
      setText("");
      onWritten();
    },
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
      <div>
        <Button size="sm" type="submit" disabled={write.pending || name.trim() === "" || text.trim() === ""}>
          Save
        </Button>
      </div>
      {write.error && <p className="text-destructive text-xs whitespace-pre-wrap">{write.error}</p>}
    </form>
  );
}
