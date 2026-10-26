import { REMOVED_REPOS_DIR, type TaskProposal } from "@trackwall/protocol";

/**
 * In place of a task's prompt, a proposal to remove a repo (ADR-83) shows the proposer's reason and what approving it
 * does, so the user knows the repo is moved, not deleted.
 */
export function RepoRemovalNote({ proposal }: { proposal: TaskProposal }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm whitespace-pre-wrap">{proposal.prompt}</p>
      <p className="text-muted-foreground max-w-prose text-xs">
        “Remove repo” moves the <span className="font-mono">{proposal.repo}</span> folder into{" "}
        <span className="font-mono">{REMOVED_REPOS_DIR}</span> in the projects folder, so it leaves Trackwall with everything in it, also
        files outside git. Move it back to restore it, or delete it there yourself. Trackwall refuses while a session, a task or a mise task
        runs in the repo.
      </p>
    </div>
  );
}
