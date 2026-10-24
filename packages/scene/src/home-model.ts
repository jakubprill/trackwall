import type { EdgeKind } from "@trackwall/protocol";

/**
 * Model widoku pulpitu (ADR-33): migawka pulpitu, czyli to, co scena pokazuje, policzone przez UI z odpowiedzi daemona.
 * Scena nie zna API ani reguł stanu: stan repo i sesji dostaje gotowy (te same reguły co lista repo i widok Sesji),
 * a warstwę repo z układu grafu. Dzięki temu źródłem migawki może być dziś odpytywanie, a później zdarzenia z `/ws`.
 */

/**
 * Stan repo na pulpicie, w kolejności od najmniej do najbardziej pilnego: `unavailable` to stan repo `unavailable`,
 * `changed` to lokalne zmiany, `behind` to commity do pobrania; repo tylko z niewypchniętymi commitami jest `clean`.
 */
export const HOME_REPO_STATES = ["clean", "behind", "changed", "unavailable"] as const;
export type HomeRepoState = (typeof HOME_REPO_STATES)[number];

export interface HomeRepo {
  id: string;
  /**
   * Warstwa z grafu (§5.5), ta sama co kolumna w „Przeglądzie”: 0 to repo, którego nikt nie używa, ostatnia to
   * biblioteki. `null` dla repo bez połączeń w grafie; takie repo dostaje własny łuk za ostatnią warstwą.
   */
  layer: number | null;
  state: HomeRepoState;
  /** Lokalne zmiany przy `changed`, commity do pobrania przy `behind`; inaczej 0. */
  count: number;
  /** Repo ma `mise.toml`, więc da się w nim uruchamiać taski. */
  hasMise: boolean;
  /** Nazwa działającego taska mise albo `null`. */
  runningTask: string | null;
}

/**
 * Stan sesji na pulpicie: `attention` to „czeka na Ciebie” (`Session.needsAttention`: `Input`, `Approval`, `Plan`),
 * `error` to sesja zakończona błędem, `done` to sesja zakończona, a `working` to reszta, także `Stale`.
 */
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
  /** Liczba warstw grafu (kolumn „Przeglądu”); `HomeRepo.layer` jest od 0 do `layerCount - 1`. */
  layerCount: number;
  repos: readonly HomeRepo[];
  sessions: readonly HomeSession[];
  links: readonly HomeLink[];
  daemonRunning: boolean;
}

/** Klucz obiektu sceny, ten sam w zdarzeniach wyboru, etykietach i encjach. */
export type HomeKey = `repo:${string}` | `session:${string}` | "daemon";

const REPO_PREFIX = "repo:";
const SESSION_PREFIX = "session:";

export const repoKey = (id: string): HomeKey => `${REPO_PREFIX}${id}`;
export const sessionKey = (id: string): HomeKey => `${SESSION_PREFIX}${id}`;
export const DAEMON_KEY: HomeKey = "daemon";

/** Co wskazuje klucz; `null` dla klucza, który nie jest obiektem pulpitu (np. przewód albo łuk warstwy). */
export type HomeTarget = { kind: "repo" | "session"; id: string } | { kind: "daemon" };

export function parseHomeKey(key: string): HomeTarget | null {
  if (key === DAEMON_KEY) return { kind: "daemon" };
  if (key.startsWith(REPO_PREFIX)) return { kind: "repo", id: key.slice(REPO_PREFIX.length) };
  if (key.startsWith(SESSION_PREFIX)) return { kind: "session", id: key.slice(SESSION_PREFIX.length) };
  return null;
}

export function isHomeKey(key: string): key is HomeKey {
  return parseHomeKey(key) !== null;
}
