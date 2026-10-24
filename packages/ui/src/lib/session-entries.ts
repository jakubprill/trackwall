import type { Session, SessionList, Task } from "@trackwall/protocol";

/**
 * Pozycje listy w widoku „Sesje” (§4.4, ADR-31): sesja w korzeniu repo albo zadanie z ostatnią sesją, jeśli ma ją
 * w tym działaniu daemona. Zadanie nie zna swojej sesji, to sesja wskazuje zadanie (`Session.task`). Zadanie jest
 * jedną pozycją, choć po wznowieniu ma nową sesję, a bez sesji (po restarcie daemona albo zamknięciu sesji) zostaje
 * na liście do zakończenia.
 */
export type SessionEntry = { kind: "session"; session: Session } | { kind: "task"; task: Task; session: Session | undefined };

/** Co pokazuje prawa część widoku: formularz nowej sesji, wybraną sesję albo zadanie, a bez wyboru pierwszą pozycję. */
export type SessionSelection = { kind: "new" } | { kind: "session"; id: string } | { kind: "task"; id: string } | undefined;

/** Od ostatnio uruchomionej: sesja po starcie, zadanie po starcie swojej ostatniej sesji, a bez sesji po utworzeniu. */
export function sessionEntries({ sessions, tasks }: SessionList): SessionEntry[] {
  const entries: SessionEntry[] = [
    ...sessions.filter((s) => s.task === null).map((session) => ({ kind: "session" as const, session })),
    ...tasks.map((task) => ({ kind: "task" as const, task, session: latestSession(sessions, task.id) })),
  ];
  return entries.sort((a, b) => entryTime(b).localeCompare(entryTime(a)));
}

function latestSession(sessions: readonly Session[], task: string): Session | undefined {
  return sessions.filter((s) => s.task === task).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function entryTime(entry: SessionEntry): string {
  if (entry.kind === "session") return entry.session.startedAt;
  return entry.session?.startedAt ?? entry.task.createdAt;
}

/** Pozycja dla wyboru, a bez wyboru albo dla nieznanego pierwsza; sesja zadania (np. z traya albo „Następna czekająca”) wybiera jej zadanie. */
export function findEntry(entries: readonly SessionEntry[], selection: SessionSelection): SessionEntry | undefined {
  if (selection?.kind === "new") return undefined;
  if (!selection) return entries[0];
  const found = entries.find((entry) =>
    selection.kind === "task" ? entry.kind === "task" && entry.task.id === selection.id : entry.session?.id === selection.id,
  );
  return found ?? entries[0];
}

/** Wybór, który wskazuje tę pozycję. */
export function entrySelection(entry: SessionEntry): SessionSelection {
  return entry.kind === "task" ? { kind: "task", id: entry.task.id } : { kind: "session", id: entry.session.id };
}

/** Identyfikator pozycji (klucz Reacta i porównanie z wybraną). */
export function entryId(entry: SessionEntry): string {
  return entry.kind === "task" ? entry.task.id : entry.session.id;
}
