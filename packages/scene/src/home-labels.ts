import type { HomeRepo, HomeSession } from "./home-model.ts";
import type { SceneLabelMode } from "./scene-style.ts";

/**
 * Which objects have a label on the scene (ADR-33, ADR-104); the rest is in the hover preview card and in the UI panels.
 * A repo where something is going on (not clean, or a mise task running) gets a full label with its numbers; with the mode
 * `all` a clean, quiet repo gets a quiet label with only its name, so every repo on the ring can be told apart. A working
 * session has no label, because colour and motion say enough. The scene only decides whether and how loud a label is; the
 * UI writes its text (`createLabel`), in the same words as the rest of the application.
 */

export type RepoLabelTone = "full" | "quiet";

export function repoLabelTone(repo: HomeRepo, mode: SceneLabelMode): RepoLabelTone | null {
  if (repo.state !== "clean" || repo.runningTask !== null) return "full";
  return mode === "all" ? "quiet" : null;
}

export function sessionHasLabel(session: HomeSession): boolean {
  return session.state === "attention" || session.state === "error";
}
