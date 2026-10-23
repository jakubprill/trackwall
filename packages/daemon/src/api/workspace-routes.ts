import { AddRepoRequest, FileRequest, RepoRequest, TreeRequest, WORKSPACE_ROUTES } from "@pitwall/protocol";
import { z } from "zod";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";

/** Trasa `POST /api/<moduł>/<akcja>` (§5.2): ciało walidowane schematem z `@pitwall/protocol`, wynik w `data`. */
export interface PostRoute {
  handle(facade: Facade, body: unknown): Promise<unknown>;
}

function route<S extends z.ZodType>(schema: S, run: (facade: Facade, body: z.infer<S>) => unknown): PostRoute {
  return {
    async handle(facade, body) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new DomainError("bad_request", z.prettifyError(parsed.error));
      return run(facade, parsed.data);
    },
  };
}

const NoBody = z.object({}).strict();

export const workspaceRoutes: Record<string, PostRoute> = {
  [WORKSPACE_ROUTES.list]: route(NoBody, (f) => f.workspace.list()),
  [WORKSPACE_ROUTES.add]: route(AddRepoRequest, (f, b) => f.workspace.add(b.path)),
  [WORKSPACE_ROUTES.remove]: route(RepoRequest, (f, b) => {
    f.workspace.remove(b.repo);
    return { removed: true };
  }),
  [WORKSPACE_ROUTES.overview]: route(RepoRequest, (f, b) => f.workspace.overview(b.repo)),
  [WORKSPACE_ROUTES.tree]: route(TreeRequest, (f, b) => f.workspace.tree(b.repo, b.path)),
  [WORKSPACE_ROUTES.file]: route(FileRequest, (f, b) => f.workspace.file(b.repo, b.path)),
  [WORKSPACE_ROUTES.openEditor]: route(RepoRequest, (f, b) => {
    f.workspace.openEditor(b.repo);
    return { opened: true };
  }),
};
