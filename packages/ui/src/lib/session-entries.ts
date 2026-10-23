import type { Session, SessionList, Task } from "@trackwall/protocol";

/**
 * Pozycje listy w widoku „Sesje” (§4.4, ADR-31): sesja w korzeniu repo albo zadanie z ostatnią sesją, jeśli ma ją
 * w tym działaniu daemona. Zadanie jest jedną pozycją, choć po wznowieniu ma nową sesję, a bez sesji (po restarcie
 * daemona albo zamknięciu sesji) zostaje na liście do usunięcia.
 */
export type SessionEntry = { kind: "session"; session: Session } | { kind: "task"; task: Task; session: Session | undefined };

/** Co pokazuje prawa część widoku: formularz nowej sesji, wybraną sesję albo zadanie, a bez wyboru pierwszą pozycję. */
export type SessionSelection = { kind: "new" } | { kind: "session"; id: string } | { kind: "task"; id: string } | undefined;

/** Od ostatnio uruchomionej: sesja po starcie, zadanie po starcie swojej sesji, a bez sesji po utworzeniu. */
export function sessionEntries({ sessions, tasks }: SessionList): SessionEntry[] {
  const entries: SessionEntry[] = [
    ...sessions.filter((s) => s.task === null).map((session) => ({ kind: "session" as const, session })),
    ...tasks.map((task) => ({ kind: "task" as const, task, session: sessions.find((s) => s.id === task.session) })),
  ];
  return entries.sort((a, b) => entryTime(b).localeCompare(entryTime(a)));
}

function entryTime(entry: SessionEntry): string {
  return entry.session?.startedAt ?? (entry.kind === "task" ? entry.task.createdAt : "");
}

/** Pozycja dla wyboru; sesja zadania (np. z traya albo „Następna czekająca”) wybiera jej zadanie. */
export function findEntry(entries: readonly SessionEntry[], selection: SessionSelection): SessionEntry | undefined {
  if (selection?.kind === "new") return undefined;
  const found = entries.find((entry) =>
    selection?.kind === "task" ? entry.kind === "task" && entry.task.id === selection.id : entry.session?.id === selection?.id,
  );
  return found ?? entries[0];
}

/** Identyfikator pozycji (klucz Reacta i porównanie z wybraną). */
export function entryId(entry: SessionEntry): string {
  return entry.kind === "task" ? entry.task.id : entry.session.id;
}
