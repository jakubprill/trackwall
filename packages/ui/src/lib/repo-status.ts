import { type RepoStatus, type RepoStatusOk, trackedChanges } from "@trackwall/protocol";
import { workingTreeLabel } from "./format.ts";

/** Ton stanu w UI; kolor do tonu dobiera `lib/status-tone.ts`, a tokeny są w `index.css` (ADR-16). */
export type StatusTone = "ok" | "warning" | "error";

/**
 * Stan repo w jednej linii (§4.5): ton kropki i tekst obok niej. Jedno miejsce reguły
 * „niedostępne = błąd, zmiany w katalogu roboczym = ostrzeżenie, czysto = ok” dla listy i nagłówka repo.
 */
export function repoStatusTone(status: RepoStatus): { tone: StatusTone; label: string } {
  if (status.kind !== "ok") return { tone: "error", label: "unavailable" };
  const changes = workingTreeLabel(trackedChanges(status), status.untracked);
  return changes ? { tone: "warning", label: changes } : { tone: "ok", label: "clean" };
}

/**
 * Lista repo i ich stan pochodzą z folderu z projektami i z gita przy każdym zapytaniu (§4.5): `git status` w każdym
 * repo, więc „Repos” i „Home” odpytują ją rzadko i tak samo często.
 */
export const REPO_LIST_POLL_MS = 10_000;

/**
 * Lista repo nie istnieje, dopóki folder z projektami nie zostanie poprawiony w ustawieniach: zniknął albo jest źle
 * wpisany w `workspace.yaml`. Stara lista wyglądałaby wtedy na aktualną, więc widoki jej nie pokazują.
 */
export function listNeedsSettings(errorCode: string | undefined): boolean {
  return errorCode === "projects_dir_unavailable" || errorCode === "invalid_config";
}

export function branchLabel(status: RepoStatusOk): string {
  return status.branch ?? "detached HEAD";
}
