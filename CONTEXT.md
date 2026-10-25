# Trackwall glossary

Terms that are easy to confuse. Code, UI, MCP tools and documentation use these words and only these: in prose, the UI, daemon messages and MCP tool descriptions the word in bold (or the product word the entry names, ADR-32), in code the identifier given with the entry. Details are in `docs/architecture.md`; here is only what you need to know to name a thing correctly. A new term is added in the same PR in which it appears.

## Application

**Daemon** (`daemon`):
The `trackwall-daemon` process, which holds all the state and all the logic. The only source of truth; the UI, the `ws` CLI and agents (through the MCP server in the daemon) are clients of its facade.
_Avoid_: backend, server (without qualification)

**Shell** (`apps/desktop`):
The Tauri app: windows, tray, starting and supervising the daemon as a sidecar, the WebView2 check. It contains no domain logic.
_Avoid_: app (when only Tauri is meant)

**View** (`View`):
A screen of the app in the UI (Home, Repos, Sessions, Overview, Daemon, Settings), switched with the view bar (`ActivityBar`) at the left edge of the window or with a shortcut.
_Avoid_: tab (for a whole screen)

**Tab** (`TabBar`):
A switch for part of the content inside a view, for example README, Files, Commits and mise tasks in the Repos view.

**Window** (`windows.rs` in the shell; label `main` or `window-<n>`):
A desktop shell window with the whole UI and its own view (ADR-49). The main window comes from `tauri.conf.json` and hides to the tray; an extra window is opened with "Open in new window" and closes for real.
_Avoid_: screen (that is a monitor), tab (that is `TabBar`), terminal window (that is a session terminal)

**Trackwall link** (`trackwall://`, `trackwallLink`, `TRACKWALL_LINK_SCHEME`, `TRACKWALL_LINK_KINDS`; in the shell `link.rs`):
`trackwall://repo/<repo id>`, `trackwall://session/<session id>` or `trackwall://task/<task id>`: shows that thing in the window (ADR-52). Only navigates, never runs anything.
_Avoid_: deep link; plain "link" (that is a link in a README, ADR-35)

**Jump** (`Jump`, `jump::request`, `take_jump`, `useJumpRequest`):
The shell's request to the UI to show a repo, session, task or task proposal, from the tray or from a Trackwall link.
_Avoid_: focus (that is keyboard focus and the "seen" frame)

**Facade** (`Facade`):
The set of daemon module interfaces passed to the transports (HTTP, MCP, events). Modules talk to each other only through it.

**Module**:
A separate part of the daemon from §4 of the architecture (`procs`, `logs`, `workspace`…), with an explicit interface and a list of dependencies. §4 calls its interface a "service class"; in code do not give it the `Service` suffix, because that word belongs to a service from the workspace.
_Avoid_: service (that is a workspace entity, see below), pnpm package

**pnpm package**:
A pnpm package from `pnpm-workspace.yaml` (`@trackwall/daemon`, `@trackwall/protocol`, `@trackwall/ui`, `@trackwall/desktop`).
_Avoid_: workspace (that is a separate term, see below)

**`ws`**:
A thin CLI client of the daemon over HTTP on loopback. It has nothing to do with the `/ws` WebSocket.

**Daemon token**:
The secret from `~/.trackwall/daemon.json` with which the UI, `ws`, the shell and the stdio bridge authenticate to the API and the MCP server.

**MCP server** (`/mcp`, `createMcpEndpoint`):
The part of the daemon through which agents read its state with MCP tools; the same port and token as the API (§5.3, ADR-24).

**MCP tool** (`McpTool`, the `mcpTools` list in protocol, for example `list_repos`, `get_repo`, `tail`, `who_calls`, `find_endpoint`, `search_code`, `list_sessions`, `start_service`, `call_endpoint`):
One call of the MCP server with an English name, input and result described by a schema from `packages/protocol/src/mcp.ts`; a mapping to the facade, without domain logic of its own.
_Avoid_: command, action (those are API and CLI terms)

**Stdio bridge** (`trackwall-daemon mcp-stdio`, `mcpStdioCommand`):
The process an agent CLI starts as a local MCP server; it passes messages from stdin to the MCP server of the running daemon, with the port and token from `daemon.json`.
_Avoid_: proxy, thin client (without qualification)

**Session token** (`session-token` in the session directory, the `x-trackwall-session-token` header, `callerSession`):
A random token of every Trackwall session next to the daemon token, which its stdio bridge sends to the MCP server; by it the daemon knows which session is calling and, for example, stores a summary only in that session's task (ADR-39, §8). An agent outside Trackwall does not have it.
_Avoid_: task token (an earlier plan; every session has a token, also in a repo root)

## Workspace and knowledge

**Workspace** (`workspace`):
The user's set of repos (the repos from the projects folder) and its configuration in `workspace.yaml`, outside the Trackwall repository. Everything company-specific lives here.
_Avoid_: project

**Projects folder** (`projectsDir`):
One directory on the user's disk, set in `workspace.yaml` or in the settings. Each of its direct subdirectories with `.git` is a repo of the workspace (ADR-18); a repo is added by cloning it into this folder.
_Avoid_: workspace directory, root, folder (without qualification)

**Dropped folder** (`DroppedFolder`, action `dropped-folder`, UI `FolderDrop`; in Polish *upuszczony folder*):
A folder or file dropped on the Trackwall window outside a session terminal, described by the daemon: a listed repo (or a folder inside one), the projects folder, a repo elsewhere, a hidden repo, a folder with repos, a folder without repos or a file (ADR-51). It never adds a repo by itself; it can only lead to a new projects folder.
_Avoid_: imported repo, added repo

**Repo host** (`RepoHost`, `repoHosts` in `workspace.yaml`):
GitLab or GitHub with a host name (`gitlab.example.com`), from which Trackwall searches for repos and clones them into the projects folder through a logged-in `glab` or `gh` (ADR-19).
_Avoid_: remote (that is the name of a remote in git, for example `origin`), server, source (that is a log term)

**Remote repo** (`RemoteRepo`, full name `fullName`):
A repo on a host available to the user, for example `group/subgroup/project`. The last segment of the full name is the clone directory.

**Clone** (`CloneJob`):
A clone of one remote repo into the projects folder, in the background: `running`, `done` or `failed` with a message. Kept only in daemon memory.

**Repo** (`Repo`, `RepoId`):
One repository of the workspace, identified by a slug from the name of its directory.

**Remote address** (`Repo.remote`):
The address of the main remote (`origin` or the only remote in git, `mainRemote`) as `host/path`, for example `gitlab.example.com/shop/api`, without the protocol and user. It identifies the repo independently of the directory name (ADR-21).
_Avoid_: repo URL (a URL has a protocol and may carry a token), remote without qualification (that is a name in git, for example `origin`)

**Sync** (`SyncRun`, repo result `SyncRepo`):
A fetch of every repo from the projects folder and a fast-forward of its default branch, in the background, with a result per repo: moved, up to date, skipped with a reason (`SyncSkipReason`) or an error; without an error also with the state of the working directory after the sync (`SyncWorkingTree`, ADR-34). It never merges or overwrites local changes (ADR-21). Kept only in daemon memory.
_Avoid_: pull, update (without qualification)

**Batch command** (`BatchRun`, step `BatchStep`, repo result `BatchRepo`):
Selected steps on selected repos with one button: sync (`sync`), tools from the repo's mise configuration (`tools`, `mise install`), dependencies (`setup`, the mise task `setup`) and build (`build`, the mise task `build`), in a repo always in this order, several repos at once, with the result of every step in every repo (ADR-27). A step error ends the repo, the others go on. Kept only in daemon memory.
_Avoid_: bulk operation, workflow

**Repo status** (`RepoStatus`):
The branch, the last commit, the number of changes in the working directory (of which, separately, new untracked files, `untracked`) and ahead/behind against the tracking branch, read from git on every request (`ok`), or `unavailable` with a message when git does not read it (a repo whose directory disappeared drops off the list). It is never stored.
_Avoid_: state (that is a task state or a service state), sync (that is a separate action)

**Changes** (working directory changes, `WorkingTreeChanges`, the `changes` action; the "Changes" tab in the UI):
The files and diff of the working directory (with new files, without ignored ones) against a commit: a repo against HEAD in the repo details (ADR-34), a task's worktree against the base commit in the task changes (`TaskChanges`, ADR-31). Read-only. An agent gets a task's changes without the diff in `get_session` (`TaskChangesSummary`) and with it, narrowed to paths, in `get_task_changes` (`AgentTaskChanges`).
In working directory counts "changed" (`changed`) are tracked files, and "new" (`untracked`) untracked entries; `RepoStatus.changes` is their sum (`trackedChanges` counts the changed ones).
_Avoid_: diff (that is only a part), status

**Repo overview** (`RepoOverview`):
The README and the latest commits of a repo in one response; the repo status comes from the repo list. Files are browsed separately, always from the HEAD commit (ADR-14).

**Test results** (`TestResults`, module `test-results`, MCP tool `get_test_results`; a **test report** is one JUnit XML file, `TestReport`; a failed test is a `TestFailure`):
The outcome of the latest test runs in a repo root or a task's worktree, read from the JUnit XML reports the build tools left on disk (ADR-60): counts of tests, failures (an assertion did not hold), errors (the test threw) and skipped, and each failed test with its message and stack trace. Trackwall runs no tests for it.
_Avoid_: test run (that is the mise task that wrote the reports), coverage

**Code search** (`searchCode`, MCP tool `search_code`, result `SearchCodeResult`):
A fixed string or a regular expression in the files of the latest commit of many repos of the projects folder at once, through `git grep` (ADR-40); a match (`CodeMatch`) is a repo, path, line, column and context lines. It does not see uncommitted changes, just like browsing a repo.
_Avoid_: grep (the tool underneath), index (there is none)

**Worktree** (task worktree, `Task.worktree`):
A separate git working directory for a task, on the task's branch, in `worktrees/<repo>/<branch without prefix>` in the state directory, outside the projects folder (ADR-31). Computed from the repo and branch (`taskWorktree`), not stored in `tasks.json`. Removed only at the user's request and only without a running task session; uncommitted changes are lost only after confirmation.

**Base commit** (`Task.base`):
The commit of the default branch from which the task's branch started. The task changes (`TaskChanges`) are the worktree's working directory against it: the task's commits and uncommitted files together.

**Trusted mise config** (`StoredTask.trustedMiseConfig`, `TaskMiseConfig`, actions `task-mise-config` and `trust-task-mise-config`; UI "Trust this config"):
The mise files of a task's worktree (config files, `.tool-versions`, file tasks) as the user consented to them, kept as hashes in `tasks.json`: as the worktree was created, or as the user trusted them later in the task panel (ADR-59). A mise task runs in the worktree only while its files match; a changed file shows up as a `MiseConfigChange`.

**Card** (repo card, `RepoCard`):
Facts about a repo extracted deterministically from build files, configuration and code in the HEAD commit: build files, what the repo provides (`provides`), what it uses (`consumes`), required tools, mechanisms and problems, every fact with evidence. It depends only on the commit, so it is computed once per commit (ADR-25). An LLM will add only a description and connection proposals marked `origin: 'llm'` (ADR-6). In the UI, the "Card" tab in the repo details.
_Avoid_: profile, metadata; "repo card" for the whole repo details panel

**Build file** (`BuildFile`):
A `pom.xml`, `build.gradle(.kts)` or `package.json` that belongs to the repo's build: a root (without a file of the same kind above it) or a module or workspace package that another build file lists (`memberOf`).

**Package** (`ProvidedPackage`, `ConsumedPackage`):
A Maven artifact (`group:artifact`), a Gradle plugin or an npm package that the repo provides or uses. Packages from the same repo are not used ones.

**App** (`ProvidedApp`, `kind: "app"` on the card):
A Spring Boot application from the repo card: the module's `spring.application.name` and the port from `server.port`. By its name a Feign client, `lb://name` or the host of an address points to the repo (ADR-30). It is not a service: a service is a process that Trackwall starts.
_Avoid_: service, microservice (for a fact from the card)

**HTTP endpoint** (`ProvidedEndpoint`, `kind: "endpoint"` on the card):
A method and full path (context path, controller prefix, method path) from a Spring controller, with the handler `Class.method`. A `null` method is any method (`@RequestMapping` without `method`). It has a request type (`request`, the parameter with `@RequestBody`) and a response type (`response`, the return type without `ResponseEntity`, `Mono` and similar wrappers), `null` when there is none or it was not read (ADR-38).

**Endpoint contract** (`ProvidedEndpoint.request` and `response`, computed by `extractContracts`):
The request type and response type of an HTTP endpoint (`ProvidedEndpoint.request`, `response`) together, from the method that contains the endpoint's mapping (ADR-38). In product texts "request and response types".

**DTO** (`Dto`, `RepoCard.dtos`):
A data type from the repo that an endpoint takes or returns, and the types of its fields: a record, a `data class`, a class with fields (a type without fields is not a DTO) or an enum (the `kind`), with fields and their types or enum constants. It is identified by the type's simple name, without the package (ADR-38).
_Avoid_: model, entity (for a type from the card)

**HTTP client** (`ConsumedHttp`, `kind: "http"` on the card, kind `HttpClientVia`):
A place from which the repo calls HTTP: a Feign or `@HttpExchange` interface, a class with `WebClient`, `RestClient` or `RestTemplate`, an address from Spring configuration, `.env` or the frontend proxy. It has the target app's name or an address, the profiles in which that address applies, and calls. An address on the card has no user, password, query or path segments that look like a token.

**Call** (`HttpCall`):
A method and path that an HTTP client calls, with the line in the code. A part of the path known only at run time is `{}`.

**Profile** (Spring profile, `ConsumedHttp.profiles`):
A name from `application-<profile>.yml` or `spring.config.activate.on-profile`; `default` is the configuration without a profile. A client with an address from configuration has a separate entry for every profile in which the address is different.

**Required tool** (`ToolRequirement`):
A tool and version from mise configuration or `.tool-versions` (source `mise`) or from a file that gives the version in its own way (`.nvmrc`, the Maven wrapper, `engines.node`; source `hint`).

**Mechanism** (`Mechanism`, `MechanismId`):
A technology recognised in the repo by a package or file (Spring Boot, Feign, Kafka, Helm…), with an inventory of evidence. An inventory, not a conclusion: a mechanism does not say whom the repo connects to.

**Extractor**:
A pure function on a commit snapshot (`RepoSnapshot`) in `modules/cards/` (`maven.ts`, `gradle.ts`, `npm.ts`, `tools.ts`, `mechanisms.ts`, `spring.ts`, `frontend-http.ts`) that returns facts with a position in the file. It executes nothing.

**Tag** (repo tag, `RepoTag`):
A short name of a group of repos (`java`, `frontend`, `bff`, `monorepo`, `no-mise`…) with a reason, computed from the card, the identifier and the remote address or from a tag rule. Tags are orthogonal: a filter with several tags shows the repos that have all of them.
_Avoid_: label, category

**Tag rule** (`repoTags` in `workspace.yaml`, `RepoTagRules`):
A tag and the identifier or remote address patterns that give it (`core-api: ["*-core"]`). For groups that are not visible in the files, for example teams.

**Connection graph** (`RepoGraph`, the `graph` module):
The repos from the projects folder as nodes (`GraphNode`) and the connections between them, computed from cards and from the `graph` entries in `workspace.yaml` anew when the commit of some repo or the configuration changes. Today a node is a repo; services (several per repo) will come with the `services` module.
_Avoid_: map, dependency diagram

**Connection** (`GraphEdge`; *edge* in the architecture document and in code):
A link from the repo that uses to the repo that is used, with a kind (`EdgeKind`: `package` and `http` from cards, `manual` from `workspace.yaml`; later `topic`), a key (a package name, an app name, a host or `localhost:<port>`, a description), a confidence and evidence. One pair of repos can have several connections; the "Overview" view draws them as one line.

**Package alias** (`graph.packages` in `workspace.yaml`):
A package name and the repo that provides it, when that repo's card does not show it (a package built outside the build files, a different name in the artifact repository). It works only for a package no repo on the list builds.

**App alias** (`graph.apps` in `workspace.yaml`):
An app name or the host of an address (case-insensitive) and the repo that serves it, when no card has that name (a gateway address, a DNS name different from `spring.application.name`).

**Manual connection** (`ManualEdge`, `graph.edges` in `workspace.yaml`):
A connection entered by the user (`from`, `to`, `note`), for example an HTTP call the cards do not see yet. A repo is given by its identifier or remote address (`RepoRef`).

**Evidence** (`Evidence`, `EdgeEvidence` in the graph):
The file and line from which a fact on the card or a connection in the graph follows; a connection's evidence also has the repo (or `null` for `workspace.yaml`) and a sentence about what is in that place.

**Confidence** (`confidence`, `EdgeConfidence` in the graph):
`exact`, `high`, `medium` or `low`. A connection from a package built by one repo and a manual connection are `exact`, from a package alias `high`, from a package built by several repos `medium`. An HTTP connection: `exact` when the app name points to one repo and every call has an endpoint in it, `high` for the app name or an app alias alone, `medium` for a host equal to the repo name, a port on `localhost` or paths matching one repo, `low` for paths matching several repos (ADR-30). In the UI: certain, almost certain, likely, possible. With `low` the daemon does nothing automatically.

**Overview** (the "Overview" view, `GraphView`, view identifier `graph`):
The view with the connection graph at full width and a details panel of the selected repo (what it uses, who uses it, evidence).
_Avoid_: dashboard (that is the 3D scene), repo overview (that is the README and commits of one repo, `RepoOverview`)

## Processes and services

**Service** (`Service`, `ServiceId`):
A repo with its mise task `dev` (`SERVICE_MISE_TASK`), its port and its readiness. Today one per repo, run from the repo root (ADR-45); later a repo may have several services.
_Avoid_: app, microservice (when the entity in Trackwall is meant)

**Service state** (`ServiceState`):
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` or `crashed`; always observed, never assumed. In the UI `healthy` reads "ready on port N" and `unhealthy` "not answering".

**Slice** (`ServiceSlice`, member `SliceMember`):
A service with every service it calls at runtime (graph edges `http` and `manual`), started together by `start_service`, dependencies first in waves (ADR-45). A member is `pending`, `started`, `running` (it was already running) or `skipped` with the reason.
_Avoid_: stack, environment (for the set of services)

**Process group** (`ProcessGroup`):
A leader process and all its descendants, stopped together: a Job Object on Windows, a new POSIX session (`setsid`) killed by `-pgid` on macOS.
_Avoid_: process tree (when the managed unit is meant)

**Group owner** (`owner`):
The key under which `procs` keeps a process group and its last state; it is given by the module that started it (today a mise task in a repo). One owner has at most one group that is not confirmed empty.

**Probe** (health):
A TCP connection to the service's port on loopback (`probePort`), with the port from its log or `server.port` on its card; it decides `healthy` / `unhealthy` (ADR-45). The planned mise task `health` is not used.

**Lease** (`Lease`):
Which branch or worktree holds a service on its port. By default the main repo; a task can take it over and give it back.
_Avoid_: lock, reservation

**Orphan**:
A process group from `runtime.json` that the daemon no longer supervises (for example after a crash). Cleaned up at daemon start only when the leader is the same process (the same start time) or is already dead while the group is alive.

## Agents

**Task** (`Task`, `TaskId`):
The work of one agent on one repo: a prompt, a worktree, a `trackwall/<slug>` branch from the default branch, sessions and a summary; eventually also a budget and leases. Today (ADR-31) the Sessions view creates it from the form or from an approved task proposal (ADR-39), it is stored in `tasks.json`, and the task session can be stopped and resumed. A task does not point to a session; the session has `Session.task`. In code and the API `task` always means a task.
_Avoid_: job; a bare *task* always means a task, a mise task is always a *mise task*

**End task** (`removeTask`, "End task" in the UI):
Removing a task's worktree, and optionally its branch. Only without a running session; what would be lost (uncommitted files, commits from a detached HEAD, a directory git no longer knows, and with the branch also the task's commits) the daemon lists in the `unsaved_changes` refusal, and it is lost only after confirmation. Files ignored by git are always lost.
_Avoid_: delete task (the task disappears from the list, but the branch may stay)

**Prompt** (`Task.prompt`):
The content of a task for the agent, typed in the Sessions view or brought by a task proposal (and edited by the user before the start); Copilot CLI gets it as the first message of the task session (`--interactive`).
_Avoid_: instruction, command

**Task title** (`Task.title`, `TaskTitle`):
A short one-line description of a task (up to 80 characters), given by the session that proposes the task, like a thread title; the branch slug comes from it. A task from the form has no title (`null`), and the UI then shows the prompt.
_Avoid_: window title (that is a session's `windowTitle`)

**Task proposal** (`TaskProposal`, MCP tool `propose_task`, the `approve-proposal` and `reject-proposal` actions):
A task that a session or an agent outside Trackwall submitted through MCP and that waits in the Sessions view for the user's decision: "Start task" turns it into a task with the same identifier, "Reject…" rejects it with an optional rejection reason. Until then nothing starts. It lives only in daemon memory (ADR-39). The proposals of one main session are one entry in the Sessions view, reviewed together (ADR-55).
_Avoid_: order, request, application

**Rejection reason** (`reason` of `reject-proposal`, `rejectionReason` of `wait_for_session`):
What the user writes when rejecting a task proposal, for the session that proposed it, so it can propose the work differently. Optional; up to 1000 characters (ADR-55).
_Avoid_: comment, feedback

**Shared files** (`TaskSharedFiles`, action `task-shared-files`):
Files that both this task and another task of the same repo change, each compared with its own base commit. The one merged second will likely get a conflict, so the task panel warns about them and leads to the other task. It is only a warning: nothing is stopped (ADR-44).
_Avoid_: overlap, collision, conflict (a conflict is only the result of a merge)

**Main session** (`proposedBy` of a task and a proposal):
A session or supervising agent that talks to the user and commissions work to other agents with task proposals, then waits for their sessions (`wait_for_session`) and reads the summaries, like a coordinator with threads in Claude (ADR-39). It is a role, not a separate kind of session: any Trackwall session or an agent outside Trackwall (`proposedBy.session: null`); the supervisor is the main session above all repos (ADR-58). In the Sessions view its tasks and proposals sit indented under it, and it carries a "main" badge with their count.
_Avoid_: orchestrator, planner (ADR-9: a human splits goals)

**mise task**:
A named command from a repo's `mise.toml`: `setup`, `dev`, `test`, `build`, `lint`, `health`. In code always qualified (`miseTask`, `mise.run(...)`), never a bare `task`. Tasks stored in the commit (`DeclaredMiseTask` in `RepoCard.mise`, type `MiseSetup`: mise configuration files and the tasks from `[tasks]` and task directories) are computed by the repo card; a repo without them has the `no-mise` tag (ADR-34). The MCP tools for mise tasks have `mise` in the name and the `miseTask` argument (`run_mise_task`, `stop_mise_task`, `wait_for_mise_task`, `list_running_mise_tasks`, ADR-41).

**Run** (`run`, `runId`, state: `RunState`):
A one-off execution of a mise task from the UI or through `run_mise_task`, with its own process group and logs. State `running`, `stopping` or `exited` (exit code, signal, whether the user stopped it, the last output lines), always observed. It is neither a task nor a service.

**mise trust** (`mise trust`, the `trust` action):
The user's consent for mise to read a repo configuration that can run programs (`[env]`, templates, hooks). Without it mise does not give the task list (`untrusted`). It can be given only in the UI.
_Avoid_: authorisation, acceptance

**Adapter**:
Everything Trackwall knows about one agent CLI: the command template, the MCP configuration, resuming, state detectors. The only adapter is Copilot CLI (ADR-8).

**Supervisor** (`isSupervisor`, `startSupervisor`, `ProposedBy.supervisor`, "Supervisor" in the UI):
The one Trackwall session above all others: Copilot CLI in the projects folder, not in a repo (`Session.repo` is `null`), at most one running at a time (ADR-58). The user talks to it in the supervisor panel on the right of every view; it plans work across repos, proposes tasks and follows them. What it proposes carries `ProposedBy.supervisor`, so that its work stays under the "Supervisor" heading of the Sessions list after the session that proposed it is gone. It is the main session above all repos; it has no more rights than any other session. Unlike a supervising agent, Trackwall starts and owns it, with a session token.
_Avoid_: orchestrator, root session, supervising agent (that is an agent outside Trackwall)

**Supervisor panel** (`SupervisorPanel`):
The column on the right of the main window, in every view, with the supervisor's terminal, its state and the work it delegated, or "Start supervisor" while there is none (ADR-58). Pinned open, or folded to a strip that keeps a bell while the supervisor or a task proposal under it waits for you; Alt+0 pins it open and puts the keyboard in its terminal.
_Avoid_: sidebar (that is the list on the left of a view), drawer

**Supervising agent**:
An agent CLI (today Copilot CLI) started by the user outside a task, for example in the projects folder, with access to the MCP server. Unlike a task session it has no worktree, budget or session token. A term from the documentation and tool descriptions; in code it has no identifier of its own, because the daemon keeps nothing about it. Not the supervisor, which is a session Trackwall runs (ADR-58).
_Avoid_: orchestrator, main agent, supervisor

**Session** (task session, `Session`, `SessionId`):
An agent CLI running in a PTY owned by the daemon, in a repo root, in a task's worktree (`Session.task`) or, for the supervisor, in the projects folder (ADR-58), as a process group, with its own `sessions/<session>/` directory (session plugin, `hooks.jsonl`). The Sessions view starts it in a repo with one click (ADR-26) or together with a task (ADR-31). A session lives only until the daemon exits, a task longer. Only `copilot-record.ts` records it.
_Avoid_: POSIX session (that is a process group term), window (that is the terminal window in the UI)

**Waiting for you** (`Session.needsAttention`, `SessionAttention`):
A running session in `Approval` or `Plan`, or in `Input` the user has not seen yet (ADR-47): the agent will not move on without a human, and the human does not know yet. The daemon computes it; the UI (the counter on the view bar, which also counts task proposals waiting for a decision, ADR-39; "Next waiting") and the tray (the "Waiting: <repo>" menu, the flashing window, the system notification and the tray panel, ADR-50) only read the field.

**Seen** (`SessionAttention.focus`, `typed`; the `focus` frame of `PtyClientMessage`):
The user has seen the session's current `Input`: a session terminal was focused and visible, or the user typed into the session, after the state began.
_Avoid_: read, acknowledged

**Idle** (`isIdle`, `IDLE_LABEL`, dashboard state `idle`):
A running session in `Input` the user has already seen (ADR-47): the agent waits for the next prompt, but no longer waits for you. Shown as "idle" in Sessions and in calm grey on the dashboard.

**Session terminal** (`SessionTerminal`):
xterm.js in the Sessions view and the supervisor panel, connected over the WebSocket `/ws/pty/<session>` to the session's PTY. Several session terminals, also in different windows, can show the same session; the PTY takes the size of the last one that reported it, and a window that comes to the front reports the size of its terminals again (ADR-49).
_Avoid_: terminal window (a window is the app window)

**Session layout** (`SessionLayout`):
How the right side of the Sessions view shows entries (ADR-48): `1` is the selected entry alone with its full panel (tabs, Stop, Resume), `2` and `4` a grid page of that many entries, `auto` a grid of the whole list, up to nine per page.
In the Sessions view the switch is labelled just "Layout".
_Avoid_: view (that is a screen of the app), mode

**Session grid** (`SessionGrid`, tile):
Several session terminals side by side in the Sessions view, one tile per list entry, on pages of the list. The tile of the selected entry has the accent ring and takes the keyboard; a tile that is waiting for you has the warning frame. A tile, like a list row, has an X that closes its session: "Close session" in the UI is `stop` and then `dismiss` in the API.
_Avoid_: split, dashboard (that is Home)

**Session shortcut** (`SessionShortcut`; Alt+1…9, Alt+0, Alt+J):
Alt (⌥ on macOS) + digit selects the entry at that position in the Sessions list; Alt+0 opens the supervisor panel (ADR-58); Alt+J opens the next session or task proposals waiting for you, also from other views (ADR-55), and the supervisor panel once nothing on the list waits but the supervisor does (ADR-58). A shortcut never reaches the session terminal. Win+Alt+J (⌃⌥J on macOS) is the global shortcut that does what Alt+J does from any app (ADR-50).

**Tray panel** (`TrayPanel`, window `tray-panel`):
The small window next to the tray icon, opened by a left click on it, with the task proposals and the sessions waiting for you (ADR-50). A click opens the entry in the main window.
_Avoid_: popup, tray menu (that is the menu on a right click)

**Screen image** (`TerminalScreen`):
The state of a session's screen, which the daemon keeps in a windowless terminal emulator and sends to a session terminal on connection, before further output.
_Avoid_: screenshot (that is a picture), output history

**Task state** (`TaskState`, change: `TaskStateChange`; *state* in product texts):
`Working`, `Input`, `Approval`, `Plan`, `Done`, `Error` or `Stale`, always with a source (`hook`, `osc`, `screen`, `keyboard`, `timeout`, `exit`) and a confidence (§4.4).

**State detector**:
A rule that infers the task state from hooks, terminal sequences, the look of the screen or a human's keys in the session terminal.

**Session key** (`SessionKey`, `sessionKey`):
Enter, a digit 1–9, Esc or Ctrl+C sent to the session terminal as a whole chunk of input (`enter`, `choice`, `escape`, `interrupt`). It answers an approval request or interrupts a turn, which Copilot CLI does not report with a hook, so it is the source of the `keyboard` state; a recording stores only the kind of key.
_Avoid_: input (that is the whole content from the keyboard), shortcut

**Session plugin** (`writeCopilotPlugin`):
A directory with `plugin.json` and `hooks.json` that the daemon gives Copilot CLI through `--plugin-dir`, so that hooks report the state of this one session only (ADR-17).
_Avoid_: plugin (without qualification), hook configuration

**Session instructions** (`writeSessionInstructions`, file `trackwall.instructions.md`):
The instruction file in the session directory that the daemon gives Copilot CLI through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`: the Trackwall version that started the session and where the user sees it, the session's role (a main session in the repo root, or a task session in its worktree with the task rules and `report_result` at the end) and the **MCP instruction** (`MCP_INSTRUCTIONS`, also the MCP server's `instructions`): when to reach for which Trackwall tool and where the documentation is (ADR-46). It changes neither the repo nor `~/.copilot`.
_Avoid_: system prompt (Copilot CLI builds it itself), repository instructions (those are files in the user's repo)

**Hook record** (`CopilotHookRecord`):
One call of a hook from the session plugin: the event, the time it was received and only the payload fields needed for the state, and for the rest only their names (without the prompt, tool arguments and results). A line of `hooks.jsonl` and a marker in the recording.
_Avoid_: record (without qualification; that is a log line)

**Window title** (`windowTitle`):
The title an agent CLI sets with the OSC 0 / 2 sequence; in Copilot CLI it is a description of the current work. Shown next to the state, it is never the state.
_Avoid_: intention, intent

**Recording** (session recording, `session.cast`):
A session's output in the asciicast v2 format with markers for hook records, session keys and the exit code, from which the state can be computed again (`replayCopilotRecording`). Without the content of keyboard input.

**Budget**:
A limit on a task's time and number of commits; when it is exceeded the daemon ends the session.

**Summary** (`Task.summary`, MCP tool `report_result`):
The result a task session reports with the `report_result` tool: what it did, what is left, what to check. It goes to the task's `summary` field (with the report time, in `tasks.json`), to the Sessions view and to the main session; a later one replaces the earlier (ADR-39). Eventually also to a PR proposal. Trackwall merges nothing by itself (ADR-9).

## Logs, events and audit

**Record** (`LogRecord`):
One line of process output after parsing: `seq`, time, run (`runId`), stream, level, content (without ANSI, with secrets masked), later optionally a trace identifier (`traceId` in TypeScript, `trace_id` in MCP tools).
_Avoid_: entry, event

**Source** (`LogSource`):
Where a record comes from. Today a repo's mise task (`{ kind: "mise-task", repo, miseTask }`); a service, a task and the daemon itself will come as further kinds. A source has the records of all its runs.

**Log** (mise task log, `logs/tail` and the MCP tool `tail`, the "Log" button in the UI):
The records of one source in `seq` order: the latest (up to 2000) in daemon memory, those newer than the last rotation in the JSONL file `logs/<kind>/<repo>/<mise task>.jsonl` in the state directory (the current file and one previous, 10 MB each, ADR-28). Do not confuse with the daemon log (the stderr of the `trackwall-daemon` process).
_Avoid_: console, terminal (that is a task session's PTY)

**Error** (error from logs, `LogError`, MCP tool `get_errors`):
A record at `error` (or `warn`) level or an exception header together with the lines that belong to it (stack trace, `Caused by:`, a Spring or Gradle report), from one source, run and stream. The same error repeated in a source is one error with a count (`count`); `exception` is its cause (ADR-42).
_Avoid_: exception (only one kind of error), problem (that is the repo card and the graph), incident

**`seq`**:
A global, increasing record number for all sources; every daemon run starts from the moment of its start, so numbers do not repeat. The cursor (`sinceSeq` in the API and in MCP tools) works for one source and for the whole workspace; `dropped` says that some records after the cursor were lost.

**Event** (`DaemonEvent`, `sessions.changed`, `mise.running.changed`):
A daemon message on the `/ws` WebSocket (ADR-36) with the whole snapshot of one topic, without a number. The daemon sends them after connection (a snapshot of every topic) and on every change of a snapshot.
_Avoid_: record (that is the log), notification (that is OSC or a hook)

**Topic snapshot** (the event `payload`, `LiveFeed` in the UI; *snapshot*):
The whole state of one event topic, the same value as the response of an HTTP action (`SessionList` from `agents/sessions`, `RunningMiseTask[]` from `mise/running`). Do not confuse with the dashboard snapshot (`HomeModel`), which the UI assembles from several topics and responses.

**Masking**:
Replacing secret values with `***` before a record is written to the buffer, the file and the last state lines. Today secrets are the values of process environment variables with secret names (`GH_TOKEN`, `DB_PASSWORD`…, §4.2).

**Audit** (`AuditEntry`):
A record of every MCP tool call: client, tool, arguments, time, result hash. Visible only in the UI.

## Secrets

**Secrets repo**:
A repository with k8s `Secret` manifests, one `origin/<repo>` branch per workspace repo (ADR-10). Cloned outside the workspace.

**Secret**:
A key from `data` or `stringData` of a manifest, injected as an environment variable with the same name. A task session only sees whether it is set.

## 3D scene

**Scene** (`@trackwall/scene`, `HomeScene`):
The dashboard's 3D scene on Pawn. It does not know the daemon API: it gets successive `HomeModel` snapshots and keeps one entity per object.

**Dashboard**:
The first screen, the "Home" view (`HomeView`): the daemon state, sessions (especially those waiting for you), repos and the connections between them, in the "Orbit" layout (`orbitLayout`).

**"Needs you" queue** (`NeedsYouPanel`):
The left panel of the dashboard: sessions that are waiting for you or have an error, then task proposals waiting for a decision (ADR-39), then repos that are not clean. Sessions and repos also have a label on the scene; proposals are not on the scene, and a click opens them in the Sessions view.

**Dashboard snapshot** (`HomeModel`):
What the dashboard shows, computed by the UI from the daemon's responses and given to the scene whole on every change.
_Avoid_: snapshot alone (that is a topic snapshot of events).

**Layer** (`HomeRepo.layer`, `HomeModel.layerCount`):
A repo's level on the dashboard, the same column as in the "Overview" view: the longest path from a repo nobody uses (entries on one side, libraries on the other). A repo without connections has no layer (`null`).

**Repo kind** (`RepoKind`: `entry`, `gateway`, `backend`, `library`):
A repo's role in the graph computed from its layer: entry, gateway, backend, library.
_Avoid_: service (that is a process from the repo configuration). On the dashboard every kind has a different solid.
