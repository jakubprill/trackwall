import { z } from "zod";
import { apiResult } from "./api.ts";

/**
 * Kontrakt modułu `workspace` (§4, §6): lista repo i przeglądanie ich zawartości z ostatniego commita.
 * Trasy: `POST /api/workspace/<akcja>` z ciałem z tego pliku.
 */

/** Slug repo w `workspace.yaml`; z nazwy katalogu, małe litery. */
export const RepoId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "identyfikator repo: małe litery, cyfry, '.', '_' i '-'");
export type RepoId = z.infer<typeof RepoId>;

/**
 * Ścieżka wewnątrz repo, zawsze z `/` (tak jak w gicie), bez `.` i `..`. Pusta znaczy korzeń.
 * Daemon przekazuje ją gitowi jako ścieżkę w drzewie commita, więc nie da się nią wyjść poza repo.
 */
export const RepoPath = z
  .string()
  .max(1024)
  .refine(
    (p) => p === "" || p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "ścieżka w repo: segmenty bez '.', '..' i pustych",
  )
  .refine((p) => !/[\\\0]/.test(p), "ścieżka w repo nie może zawierać '\\' ani znaku NUL");
export type RepoPath = z.infer<typeof RepoPath>;

export const Commit = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO 8601, czas autora. */
  date: z.string(),
});
export type Commit = z.infer<typeof Commit>;

/** Stan repo zaobserwowany w gicie przy każdym zapytaniu; nigdy nie jest zapisywany. */
export const RepoStatus = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    /** `null` przy odłączonym HEAD. */
    branch: z.string().nullable(),
    /** `null` w repo bez commitów. */
    head: Commit.nullable(),
    /** Liczba zmienionych i nieśledzonych plików w katalogu roboczym. */
    changes: z.number().int().nonnegative(),
    /** Gałąź śledzona z licznikami; `null`, gdy gałąź jej nie ma. */
    upstream: z.object({ name: z.string(), ahead: z.number().int(), behind: z.number().int() }).nullable(),
  }),
  /** Katalog zniknął albo przestał być repo gita; wpis w `workspace.yaml` zostaje. */
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type RepoStatus = z.infer<typeof RepoStatus>;

export const Repo = z.object({
  id: RepoId,
  path: z.string(),
  status: RepoStatus,
});
export type Repo = z.infer<typeof Repo>;

export const TreeEntry = z.object({
  name: z.string(),
  path: RepoPath,
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
  repo: Repo,
  readme: z.object({ path: RepoPath, text: z.string(), truncated: z.boolean() }).nullable(),
  commits: z.array(Commit),
});
export type RepoOverview = z.infer<typeof RepoOverview>;

/** Ciała żądań. `path` przy dodawaniu to ścieżka na dysku użytkownika, nie w repo. */
export const AddRepoRequest = z.object({ path: z.string().min(1).max(4096) });
export const RepoRequest = z.object({ repo: RepoId });
export const TreeRequest = z.object({ repo: RepoId, path: RepoPath });
export const FileRequest = z.object({ repo: RepoId, path: RepoPath.refine((p) => p !== "", "ścieżka pliku nie może być pusta") });

export const ReposResult = apiResult(z.array(Repo));
export const RepoResult = apiResult(Repo);
export const RepoOverviewResult = apiResult(RepoOverview);
export const TreeResult = apiResult(z.array(TreeEntry));
export const FileResult = apiResult(FileContent);
export const RemovedResult = apiResult(z.object({ removed: z.literal(true) }));
export const OpenedResult = apiResult(z.object({ opened: z.literal(true) }));

/** Ścieżki tras modułu: jedno miejsce dla daemona i UI. */
export const WORKSPACE_ROUTES = {
  list: "/api/workspace/list",
  add: "/api/workspace/add",
  remove: "/api/workspace/remove",
  overview: "/api/workspace/overview",
  tree: "/api/workspace/tree",
  file: "/api/workspace/file",
  openEditor: "/api/workspace/open-editor",
} as const;
