import type { EdgeKind } from "@trackwall/protocol";

/**
 * Model widoku pulpitu (ADR-33): migawka tego, co scena pokazuje, policzona przez UI z odpowiedzi daemona. Scena nie
 * zna API ani reguł stanu: stan repo i sesji dostaje gotowy (te same reguły co lista repo i widok Sesji), a warstwę
 * repo z układu grafu. Dzięki temu źródłem migawki może być dziś odpytywanie, a później zdarzenia z `/ws`.
 */

/** Stan repo na pulpicie, w kolejności od najmniej do najbardziej pilnego. */
export const HOME_REPO_STATES = ["clean", "behind", "changed", "unavailable"] as const;
export type HomeRepoState = (typeof HOME_REPO_STATES)[number];

export interface HomeRepo {
  id: string;
  /** Warstwa z grafu (§5.5): 0 to repo, którego nikt nie używa, ostatnia to biblioteki. */
  layer: number;
  state: HomeRepoState;
  /** Lokalne zmiany przy `changed`, commity do pobrania przy `behind`; inaczej 0. */
  count: number;
  /** Repo ma `mise.toml`, więc da się w nim uruchamiać taski. */
  hasMise: boolean;
  /** Nazwa działającego taska mise albo `null`. */
  runningTask: string | null;
}

/** Stan sesji na pulpicie: `attention` to „czeka na Ciebie” (`Session.needsAttention`). */
export const HOME_SESSION_STATES = ["working", "attention", "error", "done"] as const;
export type HomeSessionState = (typeof HOME_SESSION_STATES)[number];

export interface HomeSession {
  id: string;
  /** Repo, w którym (albo w którego worktree) działa sesja. */
  repo: string;
  state: HomeSessionState;
}

/** Połączenie z grafu: od repo, które używa, do repo używanego. */
export interface HomeLink {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface HomeModel {
  /** Nazwy warstw w kolejności, np. Frontends, BFF, Services, Libraries; repo wskazuje warstwę indeksem. */
  layers: readonly string[];
  repos: readonly HomeRepo[];
  sessions: readonly HomeSession[];
  links: readonly HomeLink[];
  daemonRunning: boolean;
}

/** Klucz obiektu sceny, ten sam w zdarzeniach wyboru, etykietach i encjach. */
export type HomeKey = `repo:${string}` | `session:${string}` | "daemon";

export const repoKey = (id: string): HomeKey => `repo:${id}`;
export const sessionKey = (id: string): HomeKey => `session:${id}`;
export const DAEMON_KEY: HomeKey = "daemon";
