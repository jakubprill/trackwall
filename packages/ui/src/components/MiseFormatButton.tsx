import { miseApi } from "@trackwall/protocol";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/**
 * "Format" for agent readiness (§4.26): `mise fmt` in each repo's root, one after another, then `onDone` so the readiness
 * is asked again. It rewrites the repos' mise config files in place, which leaves a change for git to see and commit.
 */
export function MiseFormatButton({ conn, repos, onDone }: { conn: Connection; repos: readonly string[]; onDone: () => void }) {
  const format = useAction(async () => {
    for (const repo of repos) await post(conn, miseApi.format, { repo });
  }, onDone);
  const label = repos.length === 1 ? "Format" : `Format in ${repos.length} repos`;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => format.run()}
        disabled={format.pending}
        title="Runs mise fmt, which rewrites the mise config files in the repo root"
      >
        {format.pending ? "Formatting…" : label}
      </Button>
      {format.error && <span className="text-destructive text-xs">{format.error}</span>}
    </span>
  );
}
