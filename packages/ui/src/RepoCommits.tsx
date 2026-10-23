import type { Commit } from "@trackwall/protocol";
import { relativeTime } from "@/lib/format";

export function RepoCommits({ commits }: { commits: Commit[] }) {
  if (commits.length === 0) return <p className="text-muted-foreground text-sm">Brak commitów.</p>;
  const now = new Date();
  return (
    <ol className="divide-y rounded-md border">
      {commits.map((c) => (
        <li key={c.hash} className="flex items-baseline gap-3 px-3 py-2 text-sm">
          <code className="text-muted-foreground shrink-0 text-xs">{c.hash.slice(0, 8)}</code>
          <span className="min-w-0 flex-1 truncate" title={c.subject}>
            {c.subject}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs" title={c.date}>
            {c.author}, {relativeTime(c.date, now)}
          </span>
        </li>
      ))}
    </ol>
  );
}
