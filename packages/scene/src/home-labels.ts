import type { HomeRepo, HomeSession } from "./home-model.ts";

/**
 * Labels on the scene are the bare minimum (ADR-33): the rest is in the hover preview card and in the UI panels.
 * A clean repo and a working session have no label, because colour and motion say enough; a label appears where something
 * needs doing or checking. The scene only decides whether a label exists; the UI writes its text (`createLabel`),
 * in the same words as the rest of the application.
 */

export function repoHasLabel(repo: HomeRepo): boolean {
  return repo.state !== "clean";
}

export function sessionHasLabel(session: HomeSession): boolean {
  return session.state === "attention" || session.state === "error";
}
