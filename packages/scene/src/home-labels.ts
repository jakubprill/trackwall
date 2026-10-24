import type { HomeRepo, HomeSession } from "./home-model.ts";

/**
 * Etykiety na scenie są absolutnym minimum (ADR-33): reszta jest w karcie podglądu po najechaniu i w panelach UI.
 * Czyste repo i pracująca sesja nie mają etykiety, bo mówią kolorem i ruchem; etykieta pojawia się tam, gdzie trzeba
 * coś zrobić albo coś sprawdzić. Scena decyduje tylko, czy etykieta jest, a jej treść pisze UI (`createLabel`),
 * tymi samymi słowami co reszta aplikacji.
 */

export function repoHasLabel(repo: HomeRepo): boolean {
  return repo.state !== "clean";
}

export function sessionHasLabel(session: HomeSession): boolean {
  return session.state === "attention" || session.state === "error";
}
