import { miseApi } from "@trackwall/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";

/**
 * "Format" for agent readiness (§4.26): `mise fmt` in each repo's root, one after another, then `onDone` so the readiness
 * is asked again, also after a failure, since the repos before it were formatted. It rewrites the repos' mise config files
 * in place, which leaves a change for git to see and commit.
 */
export function MiseFormatButton({ conn, repos, onDone }: { conn: Connection; repos: readonly string[]; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const format = async () => {
    setPending(true);
    const failed: string[] = [];
    for (const repo of repos) {
      await post(conn, miseApi.format, { repo }).catch((err: unknown) => failed.push(`${repo}: ${errorMessage(err)}`));
    }
    setFailures(failed);
    setPending(false);
    onDone();
  };
  const label = repos.length === 1 ? "Format" : `Format in ${repos.length} repos`;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void format()}
        disabled={pending}
        title="Runs mise fmt, which rewrites the mise config files in the repo root"
      >
        {pending ? "Formatting…" : label}
      </Button>
      {failures.map((f) => (
        <span key={f} className="text-destructive text-xs">
          {f}
        </span>
      ))}
    </span>
  );
}
