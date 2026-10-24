import { type HomeKey, type HomeModel, parseHomeKey } from "@trackwall/scene/model";
import { StatusLabel } from "@/components/StatusLabel";
import { homeRepoStateText } from "@/lib/home-model";
import type { StatusTone } from "@/lib/repo-status";

/**
 * Podgląd obiektu pod kursorem: nazwa i stan w rogu sceny. Etykiety na scenie są celowo minimalne (ADR-33), więc
 * to tutaj widać, czym jest najechany obiekt, zanim się go wybierze.
 */
export function HomeHoverCard({ target, model }: { target: HomeKey; model: HomeModel }) {
  const preview = hoverPreview(target, model);
  if (!preview) return null;
  return (
    <div role="status" className="surface pointer-events-none absolute top-3 left-3 flex flex-col gap-1 px-3 py-2 text-xs">
      <span className="hud-label">{preview.kind}</span>
      <span className="text-sm font-medium">{preview.title}</span>
      <StatusLabel tone={preview.tone} label={preview.label} />
    </div>
  );
}

type Preview = { kind: string; title: string; tone?: StatusTone; label: string };

function hoverPreview(key: HomeKey, model: HomeModel): Preview | undefined {
  const target = parseHomeKey(key);
  if (target?.kind === "daemon") {
    return model.daemonRunning
      ? { kind: "Daemon", title: "Trackwall", tone: "ok", label: "running" }
      : { kind: "Daemon", title: "Trackwall", tone: "error", label: "not responding" };
  }
  if (target?.kind === "repo") {
    const repo = model.repos.find((r) => r.id === target.id);
    if (!repo) return undefined;
    const tone: StatusTone = repo.state === "clean" ? "ok" : repo.state === "unavailable" ? "error" : "warning";
    const task = repo.runningTask ? ` · ${repo.runningTask} running` : "";
    return { kind: "Repo", title: repo.id, tone, label: `${homeRepoStateText(repo)}${task}` };
  }
  const session = target && model.sessions.find((s) => s.id === target.id);
  if (!session) return undefined;
  return { kind: "Session", title: session.repo, ...SESSION_PREVIEW[session.state] };
}

const SESSION_PREVIEW = {
  working: { tone: "ok", label: "working" },
  attention: { tone: "warning", label: "waiting for you" },
  error: { tone: "error", label: "error" },
  done: { label: "finished" },
} as const satisfies Record<HomeModel["sessions"][number]["state"], { tone?: StatusTone; label: string }>;
