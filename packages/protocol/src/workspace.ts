import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { CloneJob, CloneRequest, HostRepos, RepoHost } from "./repo-hosts.ts";

/**
 * Kontrakt modułu `workspace` (§4.5, §6): repo z folderu z projektami i przeglądanie ich zawartości z ostatniego commita.
 * Każda akcja to `POST /api/workspace/<akcja>`; `workspaceApi` trzyma ścieżkę, schemat ciała i schemat wyniku razem,
 * więc daemon i UI nie mogą ich sparować inaczej.
 */

/** Slug repo z nazwy jego katalogu w folderze z projektami, małe litery. */
export const RepoId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "identyfikator repo: małe litery, cyfry, '.', '_' i '-'");
export type RepoId = z.infer<typeof RepoId>;

/**
 * Ścieżka w drzewie commita, z `/` jak w gicie, bez `.` i `..`; pusta znaczy korzeń. Nie dotyka systemu plików
 * (ADR-14), więc `\` jest zwykłym znakiem nazwy. Bez znaków sterujących, bo daemon podaje ją gitowi liniami.
 */
export const RepoPath = z
  .string()
  .max(4096)
  .refine(
    (p) => p === "" || p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "ścieżka w repo: segmenty bez '.', '..' i pustych",
  )
  .refine((p) => [...p].every((c) => c >= " "), "ścieżka w repo nie może zawierać znaków sterujących");
export type RepoPath = z.infer<typeof RepoPath>;

export const Commit = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO 8601, czas autora. */
  date: z.string(),
});
export type Commit = z.infer<typeof Commit>;

/** Stan repo, który git zwrócił. */
export const RepoStatusOk = z.object({
  kind: z.literal("ok"),
  /** `null` przy odłączonym HEAD. */
  branch: z.string().nullable(),
  /** `null` w repo bez commitów. */
  head: Commit.nullable(),
  /** Liczba zmienionych i nieśledzonych plików w katalogu roboczym. */
  changes: z.number().int().nonnegative(),
  /** Gałąź śledzona z licznikami; `null`, gdy gałąź jej nie ma albo zniknęła na zdalnym. */
  upstream: z.object({ name: z.string(), ahead: z.number().int(), behind: z.number().int() }).nullable(),
});
export type RepoStatusOk = z.infer<typeof RepoStatusOk>;

/** Stan repo zaobserwowany w gicie przy każdym zapytaniu; nigdy nie jest zapisywany. */
export const RepoStatus = z.discriminatedUnion("kind", [
  RepoStatusOk,
  /** Katalog ma `.git`, ale git go nie czyta (uszkodzone repo, brak uprawnień, brak `git` w `PATH`). */
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type RepoStatus = z.infer<typeof RepoStatus>;

export const Repo = z.object({
  id: RepoId,
  path: z.string(),
  status: RepoStatus,
});
export type Repo = z.infer<typeof Repo>;

/**
 * Pełna ścieżka folderu z projektami (ADR-18); `null`, dopóki użytkownik go nie ustawi (w ustawieniach albo
 * w `workspace.yaml`), a wtedy lista repo jest pusta.
 */
const ProjectsDir = z.string().nullable();

export const RepoList = z.object({
  projectsDir: ProjectsDir,
  /** Posortowane po nazwie katalogu. */
  repos: z.array(Repo),
});
export type RepoList = z.infer<typeof RepoList>;

export const WorkspaceSettings = z.object({
  projectsDir: ProjectsDir,
  /** Hostingi, z których można sklonować repo do folderu z projektami (ADR-19); kolejność jak w `workspace.yaml`. */
  repoHosts: z.array(RepoHost),
  /** Pełna ścieżka `workspace.yaml`, żeby użytkownik wiedział, który plik edytować ręcznie. */
  configFile: z.string(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const TreeEntry = z.object({
  name: z.string(),
  /** Ścieżka od korzenia repo, taka, jaką zwrócił git; podawana z powrotem w `tree` i `file`. */
  path: z.string(),
  kind: z.enum(["dir", "file", "submodule"]),
  /** Rozmiar w bajtach, tylko dla plików. */
  size: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

export const FileContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), size: z.number().int(), truncated: z.boolean() }),
  z.object({ kind: z.literal("binary"), size: z.number().int() }),
]);
export type FileContent = z.infer<typeof FileContent>;

export const RepoOverview = z.object({
  readme: z.object({ path: z.string(), text: z.string(), truncated: z.boolean() }).nullable(),
  /** Ostatnie commity, od najnowszego; puste w repo bez commitów. */
  commits: z.array(Commit),
});
export type RepoOverview = z.infer<typeof RepoOverview>;

export const RemoteRepoList = z.object({
  projectsDir: ProjectsDir,
  /** Po jednym wpisie na hosting z ustawień, w ich kolejności. */
  hosts: z.array(HostRepos),
});
export type RemoteRepoList = z.infer<typeof RemoteRepoList>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/workspace/${action}`, request, data };
}

const RepoRequest = z.object({ repo: RepoId }).strict();
/** Akcja bez wyniku poza potwierdzeniem. */
const Done = z.null();

export const workspaceApi = {
  list: endpoint("list", z.object({}).strict(), RepoList),
  settings: endpoint("settings", z.object({}).strict(), WorkspaceSettings),
  /** `path` to pełna ścieżka istniejącego katalogu na dysku użytkownika; zapisywana w `workspace.yaml`. */
  setProjectsDir: endpoint("set-projects-dir", z.object({ path: z.string().min(1).max(4096) }).strict(), WorkspaceSettings),
  overview: endpoint("overview", RepoRequest, RepoOverview),
  tree: endpoint("tree", z.object({ repo: RepoId, path: RepoPath }).strict(), z.array(TreeEntry)),
  file: endpoint(
    "file",
    z.object({ repo: RepoId, path: RepoPath.refine((p) => p !== "", "ścieżka pliku nie może być pusta") }).strict(),
    FileContent,
  ),
  /** Otwiera `vscode://` w systemie; daemon nie wie, czy coś obsłużyło adres. */
  openEditor: endpoint("open-editor", RepoRequest, Done),
  /** Zastępuje listę hostingów w `workspace.yaml`; bez powtórzeń. */
  setRepoHosts: endpoint("set-repo-hosts", z.object({ repoHosts: z.array(RepoHost).max(20) }).strict(), WorkspaceSettings),
  /**
   * Repo dostępne w każdym hostingu, pobierane przy każdym zapytaniu przez `gh` albo `glab`; `query` szuka w nazwie
   * (GitLab po swojej stronie, także w ścieżce grupy), puste daje ostatnio zmieniane (GitLab) albo wszystkie (GitHub).
   */
  remoteRepos: endpoint("remote-repos", z.object({ query: z.string().trim().max(100) }).strict(), RemoteRepoList),
  /** Zaczyna klonowanie i od razu zwraca je w stanie `running`; postęp przez `clones`. */
  clone: endpoint("clone", CloneRequest, CloneJob),
  /** Klonowania od startu daemona, w kolejności rozpoczęcia. */
  clones: endpoint("clones", z.object({}).strict(), z.array(CloneJob)),
};
