import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { WorkingTreeChanges } from "./changes.ts";
import { CloneJob, CloneRequest, HostRepos, RepoHosts } from "./repo-hosts.ts";
import { SyncRun } from "./sync.ts";

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
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "repo id: lowercase letters, digits, '.', '_' and '-'");
export type RepoId = z.infer<typeof RepoId>;

/**
 * Ścieżka w drzewie commita, z `/` jak w gicie, bez `.` i `..`; pusta znaczy korzeń. Nie dotyka systemu plików
 * (ADR-14), więc `\` jest zwykłym znakiem nazwy. Bez znaków sterujących, bo daemon podaje ją gitowi liniami.
 */
export const RepoPath = z
  .string()
  .max(4096)
  .refine((p) => p === "" || p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), "repo path: no empty, '.' or '..' segments")
  .refine((p) => [...p].every((c) => c >= " "), "repo path: no control characters");
export type RepoPath = z.infer<typeof RepoPath>;

/** Pełny hash commita, SHA-1 albo SHA-256; tylko taki daemon podaje gitowi jako rewizję i wpisuje w nazwy plików. */
export const CommitHash = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "full commit hash");

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
  /** Z `changes` te nieśledzone: nowe pliki, których git jeszcze nie zna. */
  untracked: z.number().int().nonnegative(),
  /** Gałąź śledzona z licznikami; `null`, gdy gałąź jej nie ma albo zniknęła na zdalnym. */
  upstream: z.object({ name: z.string(), ahead: z.number().int(), behind: z.number().int() }).nullable(),
});
export type RepoStatusOk = z.infer<typeof RepoStatusOk>;

/** Zmienione śledzone pliki: `changes` bez nowych; jedno miejsce reguły dla stanu repo i wyniku synchronizacji. */
export function trackedChanges(status: Pick<RepoStatusOk, "changes" | "untracked">): number {
  return status.changes - status.untracked;
}

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
  /**
   * Adres repo zdalnego bez schematu, użytkownika, portu i `.git`, np. `gitlab.example.com/grupa/projekt`
   * (ADR-21): to samo repo pod inną nazwą katalogu albo sklonowane przez SSH i HTTPS ma ten sam adres. Z `origin`,
   * a bez niego z jedynego remote; `null`, gdy remote nie ma, jest ich kilka bez `origin` albo to ścieżka lokalna.
   */
  remote: z.string().nullable(),
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

/**
 * Adres z README, który UI może otworzyć w przeglądarce systemu (ADR-35): tylko strona, nigdy `file:`, `mailto:`
 * ani własny protokół aplikacji. `normalize` oddaje postać kanoniczną z kodowaniem procentowym, więc do systemu
 * nie trafia spacja, cudzysłów, `\` ani znak sterujący z treści repo.
 */
export const ExternalLink = z.url({ protocol: /^https?$/, normalize: true }).max(2048);

export const RepoOverview = z.object({
  /** `format` mówi, czy README jest Markdownem (ADR-35); `.txt`, `.rst` i `.adoc` są tekstem. */
  readme: z.object({ path: z.string(), text: z.string(), truncated: z.boolean(), format: z.enum(["markdown", "text"]) }).nullable(),
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

/**
 * What a folder dropped on the window means for the repo list (ADR-51): a repo already in the projects folder, a git
 * repo somewhere else, a folder with repos directly inside it, which can become the projects folder, a folder without
 * any, or a file. Repo counts use the same rule as the list (ADR-18): direct subfolders with `.git`.
 */
export const DroppedFolder = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listed-repo"), repo: RepoId }),
  /** `parent` is the folder that holds the repo; `parentRepos` counts the repos in it, this one included. */
  z.object({ kind: z.literal("repo-elsewhere"), path: z.string(), parent: z.string(), parentRepos: z.number().int().nonnegative() }),
  /** `current` when the folder already is the projects folder. */
  z.object({ kind: z.literal("folder-with-repos"), path: z.string(), repos: z.number().int().positive(), current: z.boolean() }),
  z.object({ kind: z.literal("no-repos"), path: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type DroppedFolder = z.infer<typeof DroppedFolder>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/workspace/${action}`, request, data };
}

const RepoRequest = z.object({ repo: RepoId }).strict();

export const workspaceApi = {
  list: endpoint("list", z.object({}).strict(), RepoList),
  settings: endpoint("settings", z.object({}).strict(), WorkspaceSettings),
  /** `path` to pełna ścieżka istniejącego katalogu na dysku użytkownika; zapisywana w `workspace.yaml`. */
  setProjectsDir: endpoint("set-projects-dir", z.object({ path: z.string().min(1).max(4096) }).strict(), WorkspaceSettings),
  overview: endpoint("overview", RepoRequest, RepoOverview),
  tree: endpoint("tree", z.object({ repo: RepoId, path: RepoPath }).strict(), z.array(TreeEntry)),
  file: endpoint(
    "file",
    z.object({ repo: RepoId, path: RepoPath.refine((p) => p !== "", "the file path cannot be empty") }).strict(),
    FileContent,
  ),
  /**
   * Zmiany katalogu roboczego względem HEAD (ADR-34): pliki i diff, z nowymi plikami, bez ignorowanych. Indeks
   * użytkownika zostaje nietknięty. W repo bez commitów względem pustego drzewa.
   */
  changes: endpoint("changes", RepoRequest, WorkingTreeChanges),
  /** Otwiera adres z README w domyślnej przeglądarce (ADR-35), zamiast w oknie aplikacji. */
  openLink: endpoint("open-link", z.object({ url: ExternalLink }).strict(), Done),
  /** Otwiera `vscode://` w systemie; daemon nie wie, czy coś obsłużyło adres. */
  openEditor: endpoint("open-editor", RepoRequest, Done),
  /** Opens the repo folder in Explorer, Finder or the Linux file manager (ADR-51); like `openEditor`, without waiting for it. */
  openFolder: endpoint("open-folder", RepoRequest, Done),
  /** Says what a folder dropped on the window is (ADR-51); `path` is a full path on the user's disk, read and never saved. */
  droppedFolder: endpoint("dropped-folder", z.object({ path: z.string().min(1).max(4096) }).strict(), DroppedFolder),
  /**
   * Hostingi, z których można sklonować repo do folderu z projektami (ADR-19), w kolejności z `workspace.yaml`.
   * Osobno od `settings`, bo zły wpis w jednym kluczu nie może blokować poprawiania drugiego.
   */
  repoHosts: endpoint("repo-hosts", z.object({}).strict(), RepoHosts),
  /** Zastępuje listę hostingów w `workspace.yaml`. */
  setRepoHosts: endpoint("set-repo-hosts", z.object({ repoHosts: RepoHosts }).strict(), RepoHosts),
  /**
   * Repo dostępne w każdym hostingu, pobierane przez `gh` albo `glab` i pamiętane przez 60 s (§4.5); `query` szuka
   * w nazwie (GitLab po swojej stronie od 3 znaków, także w ścieżce grupy; krótsze i GitHub filtruje daemon), puste
   * daje ostatnio zmieniane (GitLab) albo wszystkie (GitHub).
   */
  remoteRepos: endpoint("remote-repos", z.object({ query: z.string().trim().max(100) }).strict(), RemoteRepoList),
  /** Zaczyna klonowanie i od razu zwraca je w stanie `running`; postęp przez `clones`. */
  clone: endpoint("clone", CloneRequest, CloneJob),
  /** Klonowania do bieżącego folderu z projektami od startu daemona, w kolejności rozpoczęcia. */
  clones: endpoint("clones", z.object({}).strict(), z.array(CloneJob)),
  /**
   * Zaczyna synchronizację wszystkich repo z folderu z projektami (ADR-21) i od razu ją zwraca; trwająca zwraca się
   * bez startu nowej. Postęp przez `syncRun`.
   */
  sync: endpoint("sync", z.object({}).strict(), SyncRun),
  /** Ostatnia synchronizacja bieżącego folderu z projektami od startu daemona; `null`, gdy jej nie było. */
  syncRun: endpoint("sync-run", z.object({}).strict(), SyncRun.nullable()),
};
