import { agentsApi, type Repo } from "@trackwall/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { RepoActivityItem, RepoActivityTarget } from "@/lib/repo-activity";
import { notOnServer, removalConfirmed } from "@/lib/repo-removal";
import { RepoActivityButton } from "./RepoActivityBar.tsx";

/**
 * The question before a repo is removed from the Repos view (ADR-303): where its folder goes and that nothing is deleted,
 * what it takes along that is not on the server, the work that must end first, and the repo's name to type, as on
 * GitHub. "Remove repo" stays off until nothing blocks the removal and the name is typed exactly.
 */
export function RepoRemoval({
  conn,
  repo,
  blockers,
  onOpen,
  onRemoved,
  onCancel,
}: {
  conn: Connection;
  repo: Repo;
  /** Sessions, tasks and mise tasks in the repo (`removalBlockers`). */
  blockers: readonly RepoActivityItem[];
  onOpen: (target: RepoActivityTarget) => void;
  /** The folder moved: the view leaves the repo and says where it went. */
  onRemoved: (movedTo: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const inputId = useId();
  const blocked = blockers.length > 0;
  const canRemove = !blocked && !removing && removalConfirmed(typed, repo.id);
  const takesAlong = notOnServer(repo.status);

  const remove = () => {
    setRemoving(true);
    setError(undefined);
    post(conn, agentsApi.removeRepo, { repo: repo.id, confirmation: typed }).then(
      ({ movedTo }) => onRemoved(movedTo),
      (err: unknown) => {
        setRemoving(false);
        setError(errorMessage(err));
      },
    );
  };

  return (
    <section
      aria-label={`Remove ${repo.id}`}
      className="border-destructive/40 bg-destructive/10 flex flex-col gap-3 rounded-md border p-4 text-sm"
    >
      <h2 className="font-semibold">Remove {repo.id} from Trackwall?</h2>
      <p>
        The folder moves into <span className="font-mono text-xs">.trackwall/removed</span> in the projects folder and leaves every list of
        Trackwall. Nothing is deleted: move the folder back to bring the repo back.
      </p>
      {takesAlong && <p className="text-muted-foreground">{takesAlong}</p>}
      {blocked && <Blockers blockers={blockers} onOpen={onOpen} />}
      <label htmlFor={inputId} className={blocked ? "text-muted-foreground" : undefined}>
        To confirm, type <span className="text-foreground font-mono font-semibold">{repo.id}</span>
      </label>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canRemove) remove();
        }}
      >
        <Input
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={blocked || removing}
          autoComplete="off"
          spellCheck={false}
          className="max-w-80 font-mono"
        />
        <Button type="submit" variant="destructive" size="sm" disabled={!canRemove}>
          {removing ? "Removing…" : "Remove repo"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={removing}>
          Cancel
        </Button>
      </form>
      {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}
    </section>
  );
}

/** The work to end first, each a button to where it is, as in "In this repo". Trackwall ends none of it here. */
function Blockers({ blockers, onOpen }: { blockers: readonly RepoActivityItem[]; onOpen: (target: RepoActivityTarget) => void }) {
  return (
    <div className="border-warning/40 bg-warning/10 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-warning font-semibold">First end what works in this repo</p>
      <ul className="flex flex-wrap gap-2">
        {blockers.map((item) => (
          <li key={item.key}>
            <RepoActivityButton item={item} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">A task's branch may hold work not pushed anywhere, so end it in Sessions yourself.</p>
    </div>
  );
}
