import { type Endpoint, miseApi, workspaceApi } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";

/**
 * Trasy `POST /api/<moduł>/<akcja>` (§5.2) wszystkich modułów w jednej mapie. Ścieżkę i schematy bierze
 * z `@trackwall/protocol`, więc `server.ts` nie zna modułów, a wynik akcji musi zgadzać się z kontraktem co do typu.
 */
type PostHandler = (facade: Facade, body: unknown) => Promise<unknown>;

function route<Req extends z.ZodType, Data extends z.ZodType>(
  endpoint: Endpoint<Req, Data>,
  run: (facade: Facade, body: z.output<Req>) => z.input<Data> | Promise<z.input<Data>>,
): [string, PostHandler] {
  return [
    endpoint.path,
    async (facade, body) => {
      const parsed = endpoint.request.safeParse(body);
      if (!parsed.success) throw new DomainError("bad_request", z.prettifyError(parsed.error));
      return run(facade, parsed.data);
    },
  ];
}

export const postRoutes: ReadonlyMap<string, PostHandler> = new Map([
  route(workspaceApi.list, (f) => f.workspace.list()),
  route(workspaceApi.settings, (f) => f.workspace.settings()),
  route(workspaceApi.setProjectsDir, (f, b) => f.workspace.setProjectsDir(b.path)),
  route(workspaceApi.overview, (f, b) => f.workspace.overview(b.repo)),
  route(workspaceApi.tree, (f, b) => f.workspace.tree(b.repo, b.path)),
  route(workspaceApi.file, (f, b) => f.workspace.file(b.repo, b.path)),
  route(workspaceApi.openEditor, async (f, b) => {
    await f.workspace.openEditor(b.repo);
    return null;
  }),
  route(workspaceApi.repoHosts, (f) => f.workspace.repoHosts()),
  route(workspaceApi.setRepoHosts, (f, b) => f.workspace.setRepoHosts(b.repoHosts)),
  route(workspaceApi.remoteRepos, (f, b) => f.workspace.remoteRepos(b.query)),
  route(workspaceApi.clone, (f, b) => f.workspace.clone(b.host, b.fullName)),
  route(workspaceApi.clones, (f) => f.workspace.cloneJobs()),
  route(workspaceApi.sync, (f) => f.workspace.sync()),
  route(workspaceApi.syncRun, (f) => f.workspace.syncRun()),
  route(miseApi.tasks, (f, b) => f.mise.tasks(b.repo)),
  route(miseApi.start, (f, b) => f.mise.start(b.repo, b.miseTask)),
  route(miseApi.stop, (f, b) => f.mise.stop(b.repo, b.miseTask)),
  route(miseApi.trust, (f, b) => f.mise.trust(b.repo)),
]);
