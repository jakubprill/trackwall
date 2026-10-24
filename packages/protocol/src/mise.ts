import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `mise` (§4, ADR-20): taski mise repo z workspace i ich uruchomienia. Każda akcja to
 * `POST /api/mise/<akcja>`. Klient wskazuje task nazwą z listy; komendę składa daemon (§1.2).
 */

/**
 * Nazwa taska mise taka, jaką zwraca `mise tasks ls` (np. `dev`, `build:ui`). Daemon i tak uruchamia tylko task
 * z aktualnej listy repo; schemat odrzuca to, co mise wziąłby za opcję albo czego nie da się pokazać.
 */
export const MiseTaskName = z
  .string()
  .min(1)
  .max(200)
  .refine((n) => !n.startsWith("-"), "a mise task name cannot start with '-'")
  .refine((n) => [...n].every((c) => c >= " "), "mise task name: no control characters");
export type MiseTaskName = z.infer<typeof MiseTaskName>;

export const MiseTask = z.object({
  name: MiseTaskName,
  description: z.string(),
  /** Ostatnie uruchomienie w tym działaniu daemona; `null`, gdy task nie był uruchamiany. */
  run: RunState.nullable(),
});
export type MiseTask = z.infer<typeof MiseTask>;

/**
 * Powód, dla którego mise nie podał listy, i taski, które mimo to działają (uruchomione wcześniej): bez nich błąd
 * w `mise.toml` w trakcie pracy odebrałby możliwość zatrzymania serwera z UI.
 */
const NoList = { message: z.string(), running: z.array(MiseTask) };

/** Taski repo albo powód, dla którego mise ich nie podał. */
export const MiseTasks = z.discriminatedUnion("kind", [
  /** Repo bez konfiguracji mise ma pustą listę. Task, który zniknął z konfiguracji w trakcie działania, zostaje do zatrzymania. */
  z.object({ kind: z.literal("ok"), tasks: z.array(MiseTask) }),
  /** Nie ma programu `mise` w `PATH` daemona. */
  z.object({ kind: z.literal("not_installed"), ...NoList }),
  /** mise nie czyta konfiguracji repo, dopóki użytkownik jej nie zaufa (`mise trust`, akcja `trust`). */
  z.object({ kind: z.literal("untrusted"), ...NoList }),
  /** Inny błąd mise, np. składnia `mise.toml`, albo przekroczony limit czasu; komunikat z mise. */
  z.object({ kind: z.literal("error"), ...NoList }),
]);
export type MiseTasks = z.infer<typeof MiseTasks>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/mise/${action}`, request, data };
}

const MiseTaskRequest = z.object({ repo: RepoId, miseTask: MiseTaskName }).strict();

export const miseApi = {
  tasks: endpoint("tasks", z.object({ repo: RepoId }).strict(), MiseTasks),
  /** Uruchamia task w grupie procesów (`mise run <task>` w korzeniu repo); działający już task zwraca jego stan. */
  start: endpoint("start", MiseTaskRequest, RunState),
  /** Wraca po potwierdzeniu, że żaden proces grupy nie żyje; zakończony już task zwraca jego stan. */
  stop: endpoint("stop", MiseTaskRequest, RunState),
  /** `mise trust` w korzeniu repo: zgoda użytkownika na konfigurację mise repo. Tylko z UI, nigdy z MCP (§8). */
  trust: endpoint("trust", z.object({ repo: RepoId }).strict(), MiseTasks),
};
