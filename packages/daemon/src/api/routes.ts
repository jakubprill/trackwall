import {
  agentsApi,
  batchApi,
  cardsApi,
  dayStartApi,
  type Endpoint,
  graphApi,
  localConfigApi,
  logsApi,
  mergeRequestsApi,
  miseApi,
  servicesApi,
  verificationApi,
  workspaceApi,
} from "@trackwall/protocol";
import { z } from "zod";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";

/**
 * The `POST /api/<module>/<action>` routes (§5.2) of all modules in one map. The path and schemas come
 * from `@trackwall/protocol`, so `server.ts` does not know the modules, and an action's result must match the contract's type.
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
  route(workspaceApi.setWorktreesDir, (f, b) => f.workspace.setWorktreesDir(b.path)),
  route(workspaceApi.overview, (f, b) => f.workspace.overview(b.repo)),
  route(workspaceApi.tree, (f, b) => f.workspace.tree(b.repo, b.path)),
  route(workspaceApi.file, (f, b) => f.workspace.file(b.repo, b.path)),
  route(workspaceApi.changes, (f, b) => f.workspace.changes(b.repo)),
  route(workspaceApi.openLink, (f, b) => {
    f.openLink(b.url);
    return null;
  }),
  route(workspaceApi.openEditor, async (f, b) => {
    await f.workspace.openEditor(b.repo);
    return null;
  }),
  route(workspaceApi.openFolder, async (f, b) => {
    await f.workspace.openFolder(b.repo);
    return null;
  }),
  route(workspaceApi.droppedFolder, (f, b) => f.workspace.droppedFolder(b.path)),
  route(workspaceApi.repoHosts, (f) => f.workspace.repoHosts()),
  route(workspaceApi.setRepoHosts, (f, b) => f.workspace.setRepoHosts(b.repoHosts)),
  route(workspaceApi.remoteRepos, (f, b) => f.workspace.remoteRepos(b.query)),
  route(workspaceApi.clone, (f, b) => f.workspace.clone(b.host, b.fullName)),
  route(workspaceApi.clones, (f) => f.workspace.cloneJobs()),
  route(workspaceApi.sync, (f) => f.workspace.sync()),
  route(workspaceApi.syncRun, (f) => f.workspace.syncRun()),
  route(cardsApi.card, (f, b) => f.cards.card(b.repo)),
  route(cardsApi.tags, (f) => f.cards.tags()),
  route(cardsApi.warmup, (f) => f.cards.warmupProgress()),
  route(graphApi.graph, (f) => f.graph.graph()),
  route(localConfigApi.store, (f) => f.localConfig.store()),
  route(localConfigApi.repo, (f, b) => f.localConfig.repo(b.repo)),
  route(localConfigApi.restore, (f, b) => f.localConfig.restore(b.repo)),
  route(localConfigApi.ignore, (f, b) => f.localConfig.ignore(b.repo)),
  route(miseApi.tasks, (f, b) => f.mise.tasks(b.repo)),
  route(miseApi.running, (f) => f.mise.running()),
  route(miseApi.start, (f, b) => f.mise.start({ repo: b.repo, task: b.task }, b.miseTask)),
  route(miseApi.stop, (f, b) => f.mise.stop({ repo: b.repo, task: b.task }, b.miseTask)),
  route(miseApi.trust, (f, b) => f.mise.trust(b.repo)),
  route(logsApi.tail, (f, b) => f.logs.tail(b)),
  route(servicesApi.list, (f) => f.services.list()),
  route(servicesApi.start, (f, b) => f.services.start(b)),
  route(servicesApi.stop, (f, b) => f.services.stop(b)),
  route(batchApi.start, (f, b) => f.batch.start(b)),
  route(batchApi.run, (f) => f.batch.run()),
  route(batchApi.cancel, (f) => f.batch.cancel()),
  route(dayStartApi.start, (f) => f.dayStart.start()),
  route(dayStartApi.run, (f) => f.dayStart.run()),
  route(verificationApi.start, (f, b) => f.verifications.start(b.task)),
  route(verificationApi.get, (f, b) => f.verifications.get(b.task)),
  route(verificationApi.cancel, (f, b) => f.verifications.cancel(b.task)),
  route(mergeRequestsApi.get, (f, b) => f.mergeRequests.get(b.task)),
  route(mergeRequestsApi.push, (f, b) => f.mergeRequests.push(b.task)),
  route(mergeRequestsApi.openForm, async (f, b) => {
    await f.mergeRequests.openForm(b);
    return null;
  }),
  route(agentsApi.sessions, (f) => f.agents.sessions()),
  route(agentsApi.start, (f, b) => f.agents.start(b.repo)),
  route(agentsApi.startSupervisor, (f, b) => f.agents.startSupervisor(b.conversation)),
  route(agentsApi.stop, (f, b) => f.agents.stop(b.session)),
  route(agentsApi.answerDialog, (f, b) => f.agents.answerDialog(b.session, b.dialog, b.answer)),
  route(agentsApi.dismiss, (f, b) => f.agents.dismiss(b.session)),
  route(agentsApi.createTask, (f, b) => f.agents.createTask(b.repo, b.prompt)),
  route(agentsApi.resumeTask, (f, b) => f.agents.resumeTask(b.task)),
  route(agentsApi.taskChanges, (f, b) => f.agents.taskChanges(b.task)),
  route(agentsApi.sendReview, (f, b) => f.agents.sendReview(b.task, b.comments)),
  route(agentsApi.taskSharedFiles, async (f, b) => ({ shared: await f.agents.taskSharedFiles(b.task) })),
  route(agentsApi.taskMiseConfig, (f, b) => f.agents.taskMiseConfig(b.task)),
  route(agentsApi.trustTaskMiseConfig, (f, b) => f.agents.trustTaskMiseConfig(b.task, b.digest)),
  route(agentsApi.openTaskEditor, (f, b) => {
    f.agents.openTaskEditor(b.task);
    return null;
  }),
  route(agentsApi.removeTask, async (f, b) => {
    await f.agents.removeTask(b.task, b.keepBranch, b.discardChanges);
    return null;
  }),
  route(agentsApi.approveProposal, (f, b) => f.agents.approveProposal(b.proposal, b.prompt, b.model)),
  route(agentsApi.approveRepoRemoval, async (f, b) => {
    await f.agents.approveRepoRemoval(b.proposal);
    return null;
  }),
  route(agentsApi.rejectProposal, (f, b) => {
    f.agents.rejectProposal(b.proposal, b.reason);
    return null;
  }),
]);
