import { z } from "zod";

/**
 * Hostingi repo (§4.5, ADR-19): GitHub albo GitLab, z których Trackwall listuje dostępne repo i klonuje wybrane
 * do folderu z projektami. Adres hostingu żyje tylko w `workspace.yaml` użytkownika (ADR-7).
 */

export const RepoHostKind = z.enum(["github", "gitlab"]);
export type RepoHostKind = z.infer<typeof RepoHostKind>;

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * Nazwa hosta, opcjonalnie z portem, bez schematu i ścieżki (`gitlab.example.com`, `git.local:8443`). Małe litery,
 * bo tak porównuje je daemon i tak zapisuje je `gh` i `glab`.
 */
export const HostName = z
  .string()
  .max(253)
  .transform((h) => h.toLowerCase())
  .pipe(
    z.string().regex(new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`), "nazwa hosta bez https:// i ścieżki, np. gitlab.example.com"),
  );

export const RepoHost = z.object({ kind: RepoHostKind, host: HostName }).strict();
export type RepoHost = z.infer<typeof RepoHost>;

/** Program, przez który daemon pyta hosting i klonuje z niego (ADR-19); użytkownik loguje się nim sam. */
export const HOST_CLI: Record<RepoHostKind, "gh" | "glab"> = { github: "gh", gitlab: "glab" };

export function sameHost(a: RepoHost, b: RepoHost): boolean {
  return a.kind === b.kind && a.host === b.host;
}

/** Klucz hostingu, np. `gitlab:gitlab.example.com`: do map i kluczy list w UI. */
export function hostKey(host: RepoHost): string {
  return `${host.kind}:${host.host}`;
}

/** Lista hostingów z `workspace.yaml` i ustawień: bez powtórzeń, bo każdy hosting to jedna sekcja wyników. */
export const RepoHosts = z
  .array(RepoHost)
  .max(20)
  .refine(
    (hosts) => hosts.every((h, i) => hosts.findIndex((other) => sameHost(h, other)) === i),
    "ten sam hosting jest na liście dwa razy",
  );

/** Segment ścieżki repo w hostingu: znaki, które dopuszczają GitHub i GitLab, bez `.` i `-` na początku. */
const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._-]*";

/**
 * Pełna nazwa repo w hostingu: `właściciel/repo` w GitHub, `grupa/podgrupa/projekt` w GitLab. Ostatni segment to
 * nazwa katalogu klonu. Bez `-` na początku segmentu, więc nazwa nie zostanie wzięta za opcję `gh` ani `glab`.
 */
export const RemoteRepoName = z
  .string()
  .max(512)
  .regex(new RegExp(`^${SEGMENT}(?:/${SEGMENT})+$`), "pełna nazwa repo, np. właściciel/repo albo grupa/podgrupa/repo");
export type RemoteRepoName = z.infer<typeof RemoteRepoName>;

/** Repo dostępne w hostingu dla zalogowanego użytkownika `gh` albo `glab`, tak jak podał je hosting. */
export const HostedRepo = z.object({
  fullName: RemoteRepoName,
  description: z.string().nullable(),
  webUrl: z.string(),
  /** ISO 8601, ostatnia zmiana w hostingu; `null`, gdy hosting jej nie podał. */
  updatedAt: z.string().nullable(),
});
export type HostedRepo = z.infer<typeof HostedRepo>;

/** Repo z hostingu z tym, co daemon wie o folderze z projektami. */
export const RemoteRepo = HostedRepo.extend({
  /** Katalog, do którego trafi klon: ostatni segment `fullName`. */
  dir: z.string(),
  /** W folderze z projektami jest już coś o nazwie `dir` (porównanie bez wielkości liter), więc klon się nie uda. */
  inProjectsDir: z.boolean(),
});
export type RemoteRepo = z.infer<typeof RemoteRepo>;

export const HostRepos = z.object({
  host: RepoHost,
  listing: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ok"),
      /** Bez zarchiwizowanych, w kolejności z hostingu: GitHub po nazwie, GitLab od ostatnio zmienianych. */
      repos: z.array(RemoteRepo),
      /** Hosting ma więcej repo, niż Trackwall pobiera (§4.5), więc wyników może brakować; pomaga zawężenie wyszukiwania. */
      truncated: z.boolean(),
    }),
    /** `gh` albo `glab` nie odpowiedział: brak programu, brak logowania, brak sieci; szczegóły w `message`. */
    z.object({ kind: z.literal("unavailable"), message: z.string() }),
  ]),
});
export type HostRepos = z.infer<typeof HostRepos>;

const CloneTarget = z.object({
  host: RepoHost,
  fullName: RemoteRepoName,
  /** Pełna ścieżka katalogu klonu. */
  path: z.string(),
});

/** Klonowanie jednego repo do folderu z projektami; trzymane w pamięci daemona do jego restartu. */
export const CloneJob = z.discriminatedUnion("state", [
  CloneTarget.extend({ state: z.enum(["running", "done"]) }),
  /** `message` to komunikat `gh` albo `glab`. */
  CloneTarget.extend({ state: z.literal("failed"), message: z.string() }),
]);
export type CloneJob = z.infer<typeof CloneJob>;

export const CloneRequest = z.object({ host: RepoHost, fullName: RemoteRepoName }).strict();
export type CloneRequest = z.infer<typeof CloneRequest>;
