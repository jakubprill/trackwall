import { KnowledgeKind, type KnowledgeList as KnowledgeListData, type KnowledgeListEntry, type Task } from "@trackwall/protocol";
import { Plus, Search, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import {
  KIND_LABELS,
  type KnowledgeFilter,
  kindCounts,
  knowledgeAuthor,
  knowledgeRepos,
  knowledgeSections,
  knowledgeWarnings,
} from "@/lib/knowledge";
import type { RemoteHandle } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { KnowledgeForm } from "./KnowledgeForm.tsx";

/**
 * Workspace knowledge in Plan (ADR-170, ADR-216): short facts about the user's repos that every later session in those
 * repos reads in its instructions. The middle lists them as compact rows, those waiting for the user's approval apart from
 * the approved ones, with a search and filters by kind and repo; the selected entry opens in the right column
 * (`KnowledgePanel`), where it is approved after its evidence and warnings were read. "New entry" opens the form.
 */
export function KnowledgeList({
  conn,
  knowledge,
  tasks,
  selected,
  onSelect,
  filter,
  onFilter,
}: {
  conn: Connection;
  knowledge: RemoteHandle<KnowledgeListData>;
  tasks: readonly Task[];
  selected: string | undefined;
  onSelect: (name: string) => void;
  filter: KnowledgeFilter;
  onFilter: (filter: KnowledgeFilter) => void;
}) {
  // A failed poll keeps the list, the search and a half-written entry; only a list never read gives way to the error.
  if (!knowledge.data) return knowledge.error ? <ErrorWithRetry message={knowledge.error} onRetry={knowledge.reload} /> : null;
  return (
    <>
      {knowledge.error && <p className="text-destructive px-4 pt-4 text-xs whitespace-pre-wrap">{knowledge.error}</p>}
      <KnowledgeSections
        conn={conn}
        list={knowledge.data}
        tasks={tasks}
        selected={selected}
        onSelect={onSelect}
        filter={filter}
        onFilter={onFilter}
        onChanged={knowledge.reload}
      />
    </>
  );
}

function KnowledgeSections({
  conn,
  list,
  tasks,
  selected,
  onSelect,
  filter,
  onFilter,
  onChanged,
}: {
  conn: Connection;
  list: KnowledgeListData;
  tasks: readonly Task[];
  selected: string | undefined;
  onSelect: (name: string) => void;
  filter: KnowledgeFilter;
  onFilter: (filter: KnowledgeFilter) => void;
  onChanged: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const { entries, problems } = list;
  const { toApprove, approved } = knowledgeSections(entries, filter);
  const now = new Date();
  const section = (label: string, shown: readonly KnowledgeListEntry[]) =>
    shown.length > 0 && (
      <section aria-label={label} className="flex flex-col gap-1">
        <h4 className="hud-label">
          {label} · {shown.length}
        </h4>
        <ul className="bg-card divide-y rounded-md border">
          {shown.map((entry) => (
            <KnowledgeRow
              key={entry.name}
              entry={entry}
              author={knowledgeAuthor(entry, tasks)}
              now={now}
              selected={entry.name === selected}
              onSelect={() => onSelect(entry.name)}
            />
          ))}
        </ul>
      </section>
    );
  return (
    <section aria-label="Workspace knowledge" className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium">Workspace knowledge</h2>
        <span className="text-muted-foreground text-sm">Facts every session in these repos reads first.</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          aria-expanded={writing}
          aria-controls="new-knowledge-entry"
          onClick={() => setWriting(!writing)}
        >
          <Plus /> New entry
        </Button>
      </header>
      <p className="text-muted-foreground max-w-prose text-xs">
        How to run or test something, links between repos the graph does not show, exceptions to a rule, pitfalls. Agents propose them; only
        the version you approve reaches a session.
      </p>
      {writing && (
        <KnowledgeForm
          conn={conn}
          onCancel={() => setWriting(false)}
          onWritten={(name) => {
            setWriting(false);
            onChanged();
            onSelect(name);
          }}
        />
      )}
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No knowledge yet. Write an entry, or an agent proposes one when it learns something.
        </p>
      ) : (
        <>
          <KnowledgeFilters entries={entries} filter={filter} onFilter={onFilter} />
          {toApprove.length + approved.length === 0 && <p className="text-muted-foreground text-sm">Nothing matches.</p>}
          {section("Needs your approval", toApprove)}
          {section("Approved", approved)}
        </>
      )}
      {problems.map((problem) => (
        <p key={problem.file} className="text-destructive text-xs">
          <span className="font-mono">{problem.file}</span>: {problem.message}
        </p>
      ))}
    </section>
  );
}

function KnowledgeFilters({
  entries,
  filter,
  onFilter,
}: {
  entries: readonly KnowledgeListEntry[];
  filter: KnowledgeFilter;
  onFilter: (filter: KnowledgeFilter) => void;
}) {
  const counts = kindCounts(entries, filter);
  const repos = knowledgeRepos(entries, filter.repo);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-64">
        <Search aria-hidden className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
        <Input
          aria-label="Search facts"
          placeholder="Search facts…"
          value={filter.query}
          onChange={(e) => onFilter({ ...filter, query: e.target.value })}
          className="pl-8"
        />
      </div>
      <fieldset aria-label="Kind" className="flex rounded-md border">
        {(["all", ...KnowledgeKind.options] as const).map((kind) => (
          <Button
            key={kind}
            variant={kind === filter.kind ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={kind === filter.kind}
            onClick={() => onFilter({ ...filter, kind })}
          >
            {kind === "all" ? "All" : KIND_LABELS[kind]} <span className="text-muted-foreground font-mono text-xs">{counts[kind]}</span>
          </Button>
        ))}
      </fieldset>
      {repos.length > 0 && (
        <select
          aria-label="Repo"
          value={filter.repo}
          onChange={(e) => onFilter({ ...filter, repo: e.target.value })}
          className="border-input bg-card h-8 rounded-md border px-2 text-sm"
        >
          <option value="any">Repo: any</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** An entry as one row: its kind, the fact on up to two lines, and its repos, author and age; a mark when it has a warning. */
function KnowledgeRow({
  entry,
  author,
  now,
  selected,
  onSelect,
}: {
  entry: KnowledgeListEntry;
  author: string;
  now: Date;
  selected: boolean;
  onSelect: () => void;
}) {
  const warned = !entry.approved && knowledgeWarnings(entry).length > 0;
  return (
    <li className={cn(selected && "bg-accent text-accent-foreground")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex w-full items-start gap-3 px-3 py-2 text-left"
      >
        <Badge variant="outline" className="w-24 shrink-0 justify-center">
          {KIND_LABELS[entry.kind]}
        </Badge>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="line-clamp-2 text-sm">{entry.text}</span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono">{entry.repos.length === 0 ? "whole workspace" : entry.repos.join(" ")}</span>
            <span>· {author}</span>
            <span>· {relativeTime(entry.updatedAt, now)}</span>
          </span>
        </span>
        {warned && <TriangleAlert aria-label="Check before approving" className="text-warning size-4 shrink-0" />}
      </button>
    </li>
  );
}
