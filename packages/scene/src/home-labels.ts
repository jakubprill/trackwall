import type { HomeRepo, HomeSession } from "./home-model.ts";

/**
 * Etykiety na scenie są absolutnym minimum (ADR-33): reszta jest w karcie podglądu po najechaniu i w panelach UI.
 * Czyste repo i pracująca sesja nie mają etykiety, bo mówią kolorem i ruchem; etykieta pojawia się tam, gdzie trzeba
 * coś zrobić albo coś sprawdzić.
 */

export function repoLabel(repo: HomeRepo): string | null {
  return repo.state === "clean" ? null : repo.id;
}

export function sessionLabel(session: HomeSession): string | null {
  if (session.state === "attention") return "Needs you";
  if (session.state === "error") return "Error";
  return null;
}
