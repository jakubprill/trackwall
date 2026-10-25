import { type HomeKey, type HomeModel, parseHomeKey } from "@trackwall/scene/model";
import { StatusLabel } from "@/components/StatusLabel";
import { HOME_SESSION_STATUS, type HomeStatus, homeDaemonStatus, homeRepoStatus } from "@/lib/home-model";

/**
 * A preview of the object under the cursor: name and state in a corner of the scene. Labels on the scene are deliberately
 * minimal (ADR-33), so this is where you see what the hovered object is before selecting it.
 */
export function HomeHoverCard({ target, model }: { target: HomeKey; model: HomeModel }) {
  const preview = hoverPreview(target, model);
  if (!preview) return null;
  return (
    <div role="status" className="surface pointer-events-none absolute top-3 left-3 flex flex-col gap-1 px-3 py-2 text-xs">
      <span className="hud-label">{preview.kind}</span>
      <span className="text-sm font-medium">{preview.title}</span>
      <StatusLabel tone={preview.status.tone} label={preview.status.label} />
    </div>
  );
}

function hoverPreview(key: HomeKey, model: HomeModel): { kind: string; title: string; status: HomeStatus } | undefined {
  const target = parseHomeKey(key);
  if (target?.kind === "daemon") return { kind: "Daemon", title: "Trackwall", status: homeDaemonStatus(model.daemonRunning) };
  if (target?.kind === "repo") {
    const repo = model.repos.find((r) => r.id === target.id);
    if (!repo) return undefined;
    const status = homeRepoStatus(repo);
    const label = repo.runningTask ? `${status.label} · ${repo.runningTask} running` : status.label;
    return { kind: "Repo", title: repo.id, status: { ...status, label } };
  }
  const session = target?.kind === "session" ? model.sessions.find((s) => s.id === target.id) : undefined;
  return session && { kind: "Session", title: session.repo, status: HOME_SESSION_STATUS[session.state] };
}
