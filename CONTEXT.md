# Trackwall glossary

Terms that are easy to confuse. Code, UI, MCP tools and documentation use these words and only these: in prose, the UI, daemon messages and MCP tool descriptions the word in bold (or the product word the entry names, ADR-32), in code the identifier given with the entry. Details are in `docs/architecture.md`; here is only what you need to know to name a thing correctly. A new term is added in the same PR in which it appears.

## Application

**Daemon** (`daemon`):
The `trackwall-daemon` process, which holds all the state and all the logic. The only source of truth; the UI, the `ws` CLI and agents (through the MCP server in the daemon) are clients of its facade.
_Avoid_: backend, server (without qualification)

**Shell** (`apps/desktop`):
The Tauri app: windows, tray, starting and supervising the daemon as a sidecar, the WebView2 check. It contains no domain logic.
_Avoid_: app (when only Tauri is meant)

**App update** (`updates.rs`, `UpdateCheck`; in the UI *update*):
A newer version of Trackwall from GitHub Releases, installed by the shell after the user's click and followed by a restart (ADR-53). Its **update package** is the archive the updater downloads and checks against the signature: the release zip on Windows (`portable_update.rs`), `.app.tar.gz` on macOS; the **update manifest** is `latest.json` in the release.
_Avoid_: upgrade, sync (that is the repo synchronization)

**View** (`View`):
A screen of the app in the UI (Home, Repos, Sessions, Overview, Settings), switched with the view bar (`ActivityBar`) at the left edge of the window or with a shortcut.
_Avoid_: tab (for a whole screen)

**Settings category** (`SettingsCategory`, `SETTINGS_CATEGORIES`; its sections `SettingsSection`):
A group of Settings listed on the left of the Settings view: Workspace, Repo hosts, Agents, App and Diagnostics (ADR-102). Each holds a few sections, such as the projects folder or the daemon's state.
_Avoid_: tab (that is `TabBar`), page

**Tab** (`TabBar`):
A switch for part of the content inside a view, for example README, Files, Commits and mise tasks in the Repos view.

**Window** (`windows.rs` in the shell; label `main` or `window-<n>`):
A desktop shell window with the whole UI and its own view (ADR-49). The main window comes from `tauri.conf.json` and hides to the tray; an extra window is opened with "Open in new window" and closes for real.
_Avoid_: screen (that is a monitor), tab (that is `TabBar`), terminal window (that is a session terminal)

**Start at sign-in** (`autostart.rs`, `autostart_enabled`, `set_autostart`, the `--autostart` argument; in the UI *Start at sign-in*):
Trackwall started by the system's own start entry when the user signs in, with every window hidden until the user opens it (ADR-65). `autostart` is the identifier in code; UI and documentation say "start at sign-in".
_Avoid_: launch at login, startup (that is the daemon's start)

**Waiting badge** (`badge.rs`, `Badge`, `TrayIcons`):
The number of sessions and task proposals waiting for the user on the app's icons: the Dock badge, the taskbar overlay on Windows and a dot on the tray icon (ADR-65).
_Avoid_: notification (that is the system notification, ADR-50)

**Window zoom** (`zoom.rs`, `ZoomStep`, `zoom_window`, `zoom.json`):
The zoom of a window's page, stepped with Ctrl+= / Ctrl+- / Ctrl+0 and kept per window label (ADR-65).
_Avoid_: scale (that is the monitor's scale factor)

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

**Session token** (the `x-trackwall-session-token` header in the session's `mcp-config.json` and `hooks.json`, `callerSession`):
A random token of every Trackwall session next to the daemon token, which its Copilot CLI sends to the MCP server and with its hooks (ADR-88, ADR-89); by it the daemon knows which session is calling and, for example, stores a summary only in that session's task (ADR-39, §8). An agent outside Trackwall does not have it.
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

**Repo watch** (`RepoWatch`, snapshot `RepoWatchState`, topic `repos.changed`):
The daemon's comparison, every second, of the set of repos in the projects folder and of the HEAD and refs of each, read from the files of its git directory (ADR-63). A commit, checkout, pull, fetch or a new or removed repo bumps the revision; uncommitted changes do not. The UI fetches the list, tags and the graph again after every new revision.
_Avoid_: file watcher (the daemon does not use file system notifications), working directory watch (the working directory is not watched)

**Changes** (working directory changes, `WorkingTreeChanges`, the `changes` action; the "Changes" tab in the UI):
The files and diff of the working directory (with new files, without ignored ones) against a commit: a repo against HEAD in the repo details (ADR-34), a task's worktree against the base commit in the task changes (`TaskChanges`, ADR-31). Read-only. An agent gets a task's changes without the diff in `get_session` (`TaskChangesSummary`) and with it, narrowed to paths, in `get_task_changes` (`AgentTaskChanges`).
In working directory counts "changed" (`changed`) are tracked files, and "new" (`untracked`) untracked entries; `RepoStatus.changes` is their sum (`trackedChanges` counts the changed ones).
_Avoid_: diff (that is only a part), status

**Repo overview** (`RepoOverview`):
The README and the latest commits of a repo in one response; the repo status comes from the repo list. Files are browsed separately, always from the HEAD commit (ADR-14).

**Test results** (`TestResults`, module `test-results`, MCP tool `get_test_results`; a **test report** is one JUnit XML file, `TestReport`; a failed test is a `TestFailure`):
The outcome of the latest test runs in a repo root or a task's worktree, read from the JUnit XML reports the build tools left on disk (ADR-60): counts of tests, failures (an assertion did not hold), errors (the test threw) and skipped, and each failed test with its message and stack trace. Trackwall runs no tests for it.
_Avoid_: test run (that is the mise task that wrote the reports), coverage

**Verification** (`Verification`, module `verification`, `verificationApi`, MCP tool `verify_task`; UI "Verify" and the "Verification" section of the task panel):
One verdict on a task's changes (ADR-64): the mise task `test` (`VERIFY_MISE_TASK`) run in the task's worktree, then `passed` (exit code 0 and no failed test in the test reports the run wrote), `failed` (with the first failed tests and log errors) or `cancelled`; `running` until the run ends. Kept in daemon memory, the last one of each task.
_Avoid_: check, CI, validation (that is a schema at the point of entry)

**Code search** (`searchCode`, MCP tool `search_code`, result `SearchCodeResult`):
A fixed string or a regular expression in the files of the latest commit of many repos of the projects folder at once, through `git grep` (ADR-40); a match (`CodeMatch`) is a repo, path, line, column and context lines. It does not see uncommitted changes, just like browsing a repo.
_Avoid_: grep (the tool underneath), index (there is none)

**Task worktrees folder** (`worktreesDir` in `workspace.yaml` and `tasks.json`):
The folder new task worktrees go into (ADR-84): the user's setting, or by default `.trackwall-worktrees` in the projects folder, which the repo list skips. Never the projects folder itself or a folder inside one of its repos. Each task keeps the folder it was created in, so changing the setting moves no existing worktree.

**Git program** (`gitProgram` in `workspace.yaml`):
The git the daemon starts for its local git calls (ADR-112): the user's setting, a full path such as MinGit's `git.exe`, or by default git from `PATH`. Network commands (fetch, push, clone) always use git from `PATH`.

**Worktree** (task worktree, `Task.worktree`):
A separate git working directory for a task, on the task's branch, in `<task worktrees folder>/<repo>/<branch without prefix>` (ADR-31, ADR-84). Computed from the task's worktrees folder, the repo and the branch (`taskWorktree`), not stored in `tasks.json`; a task saved before ADR-84 has it in `worktrees/` of the state directory. Removed only at the user's request and only without a running task session; uncommitted changes are lost only after confirmation.

**Base commit** (`Task.base`):
The commit of the default branch from which the task's branch started. The task changes (`TaskChanges`) are the worktree's working directory against it: the task's commits and uncommitted files together.

**Task port** (`Task.port`, `TASK_PORT_FIRST`…`TASK_PORT_LAST`, `TASK_PORT_ENV`):
A port of 41000–41999 that a task holds while it exists, the lowest one no other task holds (ADR-61). Every mise task in the task's worktree gets it in `SERVER_PORT` and `PORT`, so the task's service runs next to the one from the repo root. Reserved only among tasks, not checked against other programs.

**Included files** (`Task.included`, `WORKTREE_INCLUDE_FILE` = `.worktreeinclude`):
The files git ignores that the repo root's `.worktreeinclude` names (`.gitignore` syntax), copied into a task's worktree when it is created (ADR-61): local config such as `.env`. `included.files` lists what was copied, `included.problems` what was left out and why.
_Avoid_: copied files, local files

**Trusted mise config** (`StoredTask.trustedMiseConfig`, `TaskMiseConfig`, actions `task-mise-config` and `trust-task-mise-config`; UI "Trust this config"):
The mise files of a task's worktree (config files, `.tool-versions`, file tasks) as the user consented to them, kept as hashes in `tasks.json`: as the worktree was created, or as the user trusted them later in the task panel (ADR-59). A mise task runs in the worktree only while its files match; a changed file shows up as a `MiseConfigChange`.

**Trust notice** (`MiseTrustNotices`, `Unread.trustNotice`):
The sentence in the daemon's prompt that tells a session the user trusted the mise config that refused its last `run_mise_task`, `verify_task` or `start_service`, so it runs it again (ADR-92). The trust is "Trust this config" for a task worktree or mise trust for a repo root, and only a session refused there since its last try gets the notice.

**Local config** (`LOCAL_CONFIG_FILES`, `RepoLocalConfig`, module `local-config`; UI "Local config"):
The files a repo keeps outside git on purpose, only for this clone: `mise.local.toml` (`MISE_LOCAL_CONFIG_FILE`, mise tasks, tools and variables mise reads on top of `mise.toml`), `mise.toml` (`MISE_CONFIG_FILE`) when the repo's commits do not have it (ADR-110), and `.worktreeinclude` (ADR-86). A file the repo's commits have is not local config. Each file's state against the store is `absent`, `tracked`, `backed_up`, `pending` or `missing` (`LocalConfigFileState`); "Restore from the store" copies a missing file back, and "Ignore locally" adds the files to the clone's `.git/info/exclude`.
_Avoid_: overlay, local files (that is `.worktreeinclude`'s included files)

**Local config store** (`LOCAL_CONFIG_STORE_DIR` = `.trackwall-local`, `LocalConfigStore`; UI "Local config store"):
The git repo in the projects folder that holds the local config of every repo as `<repo folder>/<file>`, committed by Trackwall a few seconds after a file changes and pushed to the store's remote when the user added one (ADR-86). The repo list skips it.
_Avoid_: backup repo, overlay folder

**Card** (repo card, `RepoCard`):
Facts about a repo extracted deterministically from build files, configuration and code in the HEAD commit: build files, what the repo provides (`provides`), what it uses (`consumes`), required tools, mechanisms and problems, every fact with evidence. It depends only on the commit, so it is computed once per commit (ADR-25). An LLM will add only a description and connection proposals marked `origin: 'llm'` (ADR-6). In the UI, the "Card" tab in the repo details.
_Avoid_: profile, metadata; "repo card" for the whole repo details panel

**Card problem** (`CardProblem`, code `CardProblemCode`; UI "Incomplete"):
Something the card is missing or shows only in part, with a code (ADR-80): `files-not-read`, `file-invalid`, `parse-incomplete`, `truncated`, and the file or module directory it concerns (empty for the repo root or the whole repo).
_Avoid_: error, warning (the card is still built)

**Card warm-up** (`CardWarmup`, progress `CardWarmupProgress`, `cards/warmup`, topic `cards.warmup.changed`; UI "Repo cards"):
Computing the cards of new and changed repos in the background, two at once, after the daemon's start and for new repos and repos whose HEAD moved, as the repo watch sees them (ADR-63), so that the graph and MCP take them from the cache. A request never waits for it.
_Avoid_: indexing, scan, prefetch

**Build file** (`BuildFile`):
A `pom.xml`, `build.gradle(.kts)` or `package.json` that belongs to the repo's build: a root (without a file of the same kind above it) or a module or workspace package that another build file lists (`memberOf`).

**Package** (`ProvidedPackage`, `ConsumedPackage`):
A Maven artifact (`group:artifact`), a Gradle plugin or an npm package that the repo provides or uses. Packages from the same repo are not used ones.

**App** (`ProvidedApp`, `kind: "app"` on the card):
A Spring Boot application from the repo card: the module's `spring.application.name` and the port from `server.port`. By its name a Feign client, `lb://name` or the host of an address points to the repo (ADR-30). It is not a service: a service is a process that Trackwall starts.
_Avoid_: service, microservice (for a fact from the card)

**HTTP endpoint** (`ProvidedEndpoint`, `kind: "endpoint"` on the card):
A method and full path (context path, controller prefix, method path) from a Spring controller, with the handler `Class.method`, or an operation of an OpenAPI spec in the repo that no mapping in the code matches (`source: "openapi"`, ADR-87), whose handler is the controller method named like its `operationId` or `null`. A `null` method is any method (`@RequestMapping` without `method`). It has a request type (`request`, the parameter with `@RequestBody`) and a response type (`response`, the return type without `ResponseEntity`, `Mono` and similar wrappers), `null` when there is none or it was not read (ADR-38).

**OpenAPI spec** (`readOpenApiSpec`, `withOpenApi`; `ProvidedEndpoint.operation`, `OpenApiOperation`):
An OpenAPI 3 or Swagger 2 file in the repo, found by its `openapi` or `swagger` key whatever its name, that describes the repo's own API; a spec the build generates a client from describes another app and is not read for endpoints (ADR-87). Its operation (`operationId`, summary, file and line) is on the endpoint it describes. In product texts "OpenAPI spec" and, for an endpoint only in a spec, "OpenAPI".
_Avoid_: swagger (for both versions), contract (that is the request and response types)

**Endpoint contract** (`ProvidedEndpoint.request` and `response`, computed by `extractContracts`):
The request type and response type of an HTTP endpoint (`ProvidedEndpoint.request`, `response`) together, from the method that contains the endpoint's mapping (ADR-38). In product texts "request and response types".

**Endpoint reach** (`ProvidedEndpoint.reaches`, `EndpointReach`, computed by `withReaches`; `RepoCard.reachTraced`):
The client calls on the same card that an endpoint's handler reaches through the repo's Java code, through any chain of method calls and every implementation of an interface in the repo (ADR-82). "Reaches" means may call: a branch counts. `null` when the card did not trace the repo (Kotlin code, files not read or parsed). In product texts "calls made by this endpoint"; `find_endpoint` shows it as `from` (the endpoints of a caller repo that make a call) and `calls` (the endpoints of other repos an endpoint calls).
_Avoid_: trace, call path (for the fact on the card)

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
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` or `crashed`; always observed, never assumed. `stopping` lasts until the process group has ended and the port no longer answers, so it also covers an app a build tool runs outside the group (Gradle's daemon) that still holds the port. In the UI `healthy` reads "ready on port N" and `unhealthy` "not answering".

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

**Task notice** (`TaskNotice`, `taskNotices`, "Task notices" in the UI):
One short line for a section above a task's terminal: a warning (shared files, a changed mise config, files not copied) or what is there (messages, summary, verification, merge request, a running mise task). In the one-entry layout the notices are a strip of chips that "Details" unfolds; on a grid tile a badge opens them as an overlay, and a new warning lies over the terminal as a banner until opened or dismissed (ADR-91).
_Avoid_: alert, notification (that is the tray's), badge (that is only the tile's count)

**End task** (`removeTask`, "End task" in the UI):
Removing a task's worktree, and optionally its branch. Only without a running session; what would be lost (uncommitted files, commits from a detached HEAD, a directory git no longer knows, and with the branch also the task's commits) the daemon lists in the `unsaved_changes` refusal, and it is lost only after confirmation. Files ignored by git are always lost.
_Avoid_: delete task (the task disappears from the list, but the branch may stay)

**Prompt** (`Task.prompt`):
The content of a task for the agent, typed in the Sessions view or brought by a task proposal (and edited by the user before the start); Copilot CLI gets it as the first message of the task session (`--interactive`).
_Avoid_: instruction, command

**Task title** (`Task.title`, `TaskTitle`):
A short one-line description of a task (up to 80 characters), given by the session that proposes the task, like a thread title; the branch slug comes from it. A task from the form has no title (`null`), and the UI then shows the prompt.
_Avoid_: window title (that is a session's `windowTitle`)

**Task model** (`Task.model`, `TaskProposal.model`, `TaskModel`; "Model" in the UI):
The Copilot CLI model a task's session runs on, as Copilot CLI names it (`claude-opus-5.5`), passed as `--model` on every start and resume of the task's session; `null` for Copilot CLI's default. Optional: a proposer names it when the user asked for a model, and the user may change it before the start (ADR-98).
_Avoid_: LLM, engine, agent (for the model)

**Task approvals** (`Task.approvals`, `TaskProposal.approvals`, `TaskApprovals`: `ask` | `auto`; "Run without asking for approvals" in the UI, "No approvals" on the task):
Whether a task's agent asks the user before tools: `ask` (the default) as every session does, `auto` runs every tool without asking (`--allow-all-tools`) on every start and resume, deny rules still refusing. Only for a task in its own worktree; the user ticks it when starting the task, and a proposer may suggest it on a proposal (ADR-105).
_Avoid_: YOLO, autopilot (Copilot CLI's own modes, not what Trackwall passes), auto-approve

**Task proposal** (`TaskProposal`, MCP tool `propose_task`, the `approve-proposal` and `reject-proposal` actions):
A task that a session or an agent outside Trackwall submitted through MCP and that waits in the Sessions view for the user's decision: "Start task" turns it into a task with the same identifier, "Reject…" rejects it with an optional rejection reason. Until then nothing starts. It lives only in daemon memory (ADR-39). The proposals of one main session are one entry in the Sessions view, reviewed together (ADR-55).
_Avoid_: order, request, application

**Folder action** (`propose_folder_action`, `ProposalKind`):
A change to the projects folder itself that no task can make, because a task works inside one repo's worktree. A session proposes it from a closed list, it waits for the user like a task proposal, and the daemon carries it out on approval (ADR-83). Today the only one is a repo removal.
_Avoid_: command, operation

**Repo removal** (`TaskProposal.kind: "remove_repo"`, the `approve-repo-removal` action, `REMOVED_REPOS_DIR`):
The folder action that takes a repo out of the projects folder: "Remove repo" moves its folder into `.trackwall-removed` in the projects folder, where the user can move it back or delete it, once no session, task or process runs in it (ADR-83).
_Avoid_: delete repo, archive

**Rejection reason** (`reason` of `reject-proposal`, `rejectionReason` of `wait_for_session`):
What the user writes when rejecting a task proposal, for the session that proposed it, so it can propose the work differently. Optional; up to 1000 characters (ADR-55).
_Avoid_: comment, feedback

**Shared files** (`TaskSharedFiles`, action `task-shared-files`):
Files that both this task and another task of the same repo change, each compared with its own base commit. The one merged second will likely get a conflict, so the task panel warns about them and leads to the other task. It is only a warning: nothing is stopped (ADR-44).
_Avoid_: overlap, collision, conflict (a conflict is only the result of a merge)

**Review** (`send-review`, `SendReviewResult`; "Send N comments to the agent" in the UI):
The review comments the user sends to a task's agent together, from the task's "Changes" tab (ADR-62). The daemon asks the task's session to read them as soon as it waits for input (`PromptDelivery`: `typed`, `queued`, `on_resume`).
_Avoid_: code review (that is the pre-PR review in `AGENTS.md`), feedback

**Review comment** (`ReviewComment`, `ReviewSide`, MCP tool `get_review_comments`):
What the user writes on one line of a task's changes for its agent: the file, the side (`new` for an added or unchanged line, `old` for a removed one), the line number, the line's code and the text. Queued in daemon memory until the task's session reads it with `get_review_comments`, which marks it read (ADR-62).
_Avoid_: note, remark, comment on a merge request (that lives on the repo host)

**Merge request** (`MergeRequest`, module `merge-requests`, `mergeRequestsApi`; the "Merge request" section of the task panel):
The request on the repo host to merge a task branch into the task's base branch, on GitHub called a pull request. Trackwall pushes the task branch at the user's request and opens the repo host's form for it with a title and description from the task; the user creates it there, and the task panel follows it, found by the task branch as its source branch (ADR-77).
_Avoid_: pull request (except for GitHub's own pages), PR, MR in product texts

**Pipeline** (`Pipeline`, `PipelineState`):
What ran on a merge request's last commit, as one state: GitLab's pipeline, or GitHub's check runs and commit statuses summed up worst first (ADR-77).
_Avoid_: CI, build (a build is a mise task), checks

**Proposer** (`Task.proposedBy`, `proposerOf` in `proposer.ts`):
The session that proposed a task: a main session, or for the supervisor's work whichever supervisor runs now. Only the proposer sends the task's session task messages (a session in Trackwall; an agent outside Trackwall sends none), and only it gets the task's task updates (ADR-68).
_Avoid_: parent, owner, manager

**Task message** (`TaskMessage`, MCP tools `send_message` and `get_messages`; "Messages" in the task panel):
Text a task's proposer sends to the task's session: a correction, an answer, a change elsewhere to follow. The daemon asks the task's session to read it the way it asks for a review, and the task's agent reads it with `get_messages`. At most 5 to a task until the user takes part again (ADR-68).
_Avoid_: note, comment (that is a review comment), chat

**Task update** (`TaskUpdate`, MCP tool `get_updates`):
What the daemon saw happen to delegated work, for the proposer: a turn that ended, an error, the end of the session, a reported result, a verification verdict, a rejected proposal. The daemon asks the proposer to read it, so the supervisor or a main session does not poll (ADR-68).
_Avoid_: event (that is a `/ws` event), notification (that is a system notification), status

**Main session** (`proposedBy` of a task and a proposal):
A session or supervising agent that talks to the user and commissions work to other agents with task proposals, then hears about their sessions through task updates (`get_updates`; an agent outside Trackwall waits with `wait_for_session`) and reads the summaries, like a coordinator with threads in Claude (ADR-39). It is a role, not a separate kind of session: any Trackwall session or an agent outside Trackwall (`proposedBy.session: null`); the supervisor is the main session above all repos (ADR-58). In the Sessions view its tasks and proposals sit indented under it, and it carries a "main" badge with their count.
_Avoid_: orchestrator, planner (ADR-9: a human splits goals)

**mise task**:
A named command from a repo's `mise.toml`: `setup`, `dev`, `test`, `build`, `lint`, `health`. In code always qualified (`miseTask`, `mise.run(...)`), never a bare `task`. Tasks stored in the commit (`DeclaredMiseTask` in `RepoCard.mise`, type `MiseSetup`: mise configuration files and the tasks from `[tasks]` and task directories) are computed by the repo card; a repo without them, and without mise tasks in its local config (ADR-86), has the `no-mise` tag (ADR-34), and a repo with mise tasks in its local config has the `local-mise` tag (`LOCAL_MISE_TAG`, ADR-110). Each mise task of a repo's list has an **origin** (`MiseTaskOrigin`; UI "repo", "local", "outside repo"): `repo` when a file git tracks defines it, `local` when a file in the repo git does not track does, `outside` when a mise config outside the repo does (the user's global one, a parent folder's); `source` names the file (ADR-110). The MCP tools for mise tasks have `mise` in the name and the `miseTask` argument (`run_mise_task`, `stop_mise_task`, `wait_for_mise_task`, `list_running_mise_tasks`, ADR-41).

**Run** (`run`, `runId`, state: `RunState`):
A one-off execution of a mise task from the UI or through `run_mise_task`, with its own process group and logs. State `running`, `stopping` or `exited` (exit code, signal, whether the user stopped it, the last output lines), always observed. It is neither a task nor a service.

**mise trust** (`mise trust`, the `trust` action):
The user's consent for mise to read a repo configuration that can run programs (`[env]`, templates, hooks). Without it mise does not give the task list (`untrusted`). It can be given only in the UI.
_Avoid_: authorisation, acceptance

**Adapter**:
Everything Trackwall knows about one agent CLI: the command template, the MCP configuration, resuming, state detectors. The only adapter is Copilot CLI (ADR-8).

**Supervisor** (`isSupervisor`, `startSupervisor`, `ProposedBy.supervisor`, "Supervisor" in the UI):
The one Trackwall session above all others: Copilot CLI in the projects folder, not in a repo (`Session.repo` is `null` and `Session.supervisor` is `true`), at most one running at a time (ADR-58). The user talks to it in the supervisor panel on the right of every view; it plans work across repos, proposes tasks and follows them. What it proposes carries `ProposedBy.supervisor`, so that its work stays under the "Supervisor" heading of the Sessions list after the session that proposed it is gone. It is the main session above all repos; it has no more rights than any other session, and fewer: it starts without Copilot CLI's shell and file-writing tools unless the user sets `supervisor.changesCode` in `workspace.yaml` (ADR-78). Unlike a supervising agent, Trackwall starts and owns it, with a session token.
_Avoid_: orchestrator, root session, supervising agent (that is an agent outside Trackwall)

**Free session** (`isFreeSession`, `start {repo: null}`, "Free session" in the UI):
A Trackwall session in the projects folder that is not the supervisor (`Session.repo` is `null`, `Session.supervisor` is `false`): plain Copilot CLI the user talks to without a repo, any number at once (ADR-100). It may change files in any repo of the folder, without a review; to MCP it is a main session in no repo, so it proposes tasks but runs no mise task or service.
_Avoid_: repo-less session, scratch session

**Supervisor panel** (`SupervisorPanel`):
The column on the right of the main window, in every view, with the supervisor's terminal, its state and the work it delegated, or "Start my day" and "Start supervisor" while there is none, with "Resume" (the last supervisor's conversation, `SessionList.lastSupervisor`) and "New" in place of "Start supervisor" once Copilot CLI keeps one (ADR-58, ADR-70, ADR-96). Pinned open, wide ("Widen": most of the window, for reading the supervisor), or folded to a strip that keeps a bell while the supervisor or a task proposal under it waits for you (`SupervisorLayout` in `supervisor-layout.ts`); Alt+0 unfolds it, a wide panel staying wide, and puts the keyboard in its terminal.
_Avoid_: sidebar (that is the list on the left of a view), drawer

**Day start** (`DayStart`, `dayStartApi`, `DayStartRun`, `startSupervisorWith`; "Start my day" in the UI; `dayStart` in `workspace.yaml`):
The action that begins a working day (ADR-70): a sync of every repo, the day report, and a new supervisor whose first message asks it to brief the user from that report, followed by the user's own `dayStart.prompt`. Refused while a supervisor runs. "Start my day" is the button; in prose and code it is the day start.
_Avoid_: morning brief, daily standup, briefing (that is what the supervisor writes from the report)

**Day report** (`DayReport`, `get_day_report`, `day-start.json`):
What the daemon computed at the last day start (ADR-70): commits new on each repo's remote default branch since the previous day start, repos the sync did not update, and the open tasks with how far behind they are. It stays the same until the next day start.
_Avoid_: digest, changelog, summary (that is a task's `report_result`)

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

**Conversation view** (`SessionView` `"conversation"`, `ConversationView`, `AcpSession`, `ConversationEntry`; "conversation view" in the UI):
How a session shows when the daemon runs Copilot CLI over the Agent Client Protocol (`copilot --acp`) instead of in a terminal (ADR-107): a list of what the user and the agent said and the tools the agent called, its approval and a message box, all plain text in the page. The other `SessionView` is `"terminal"`, the session terminal. For now only the supervisor starts in it, when the user turns it on in the supervisor panel; its conversation goes on in either view.
_Avoid_: chat, transcript (that is Copilot CLI's own record)

**Session terminal** (`SessionTerminal`):
xterm.js in the Sessions view and the supervisor panel, connected over the WebSocket `/ws/pty/<session>` to the session's PTY. Several session terminals, also in different windows, can show the same session; the PTY takes the size of the last one that reported it, and a window that comes to the front reports the size of its terminals again (ADR-49).
_Avoid_: terminal window (a window is the app window)

**Session layout** (`SessionLayout`):
How the right side of the Sessions view shows entries (ADR-48): `1` is the selected entry alone with its full panel (tabs, Stop, Resume), `2` and `4` a grid page of that many entries, `auto` a grid of the whole list, up to nine per page.
In the Sessions view the switch is labelled just "Layout".
_Avoid_: view (that is a screen of the app), mode

**Session grid** (`SessionGrid`, tile):
Several session terminals side by side in the Sessions view, one tile per list entry, on pages of the list. The tile of the selected entry has the accent ring and takes the keyboard; a tile that is waiting for you has the warning frame. A tile, like a list row, has an X that closes its session: "Close session" in the UI is `stop` and then `dismiss` in the API. On a task without a session the X is "End task".
_Avoid_: split, dashboard (that is Home)

**Session shortcut** (`SessionShortcut`; Alt+1…9, Alt+0, Alt+J):
Alt (⌥ on macOS) + digit selects the entry at that position in the Sessions list; Alt+0 opens the supervisor panel (ADR-58); Alt+J opens the next session or task proposals waiting for you, also from other views (ADR-55), and the supervisor panel once nothing on the list waits but the supervisor does (ADR-58). A shortcut never reaches the session terminal. Win+Alt+J (⌃⌥J on macOS) is the global shortcut that does what Alt+J does from any app (ADR-50).

**Tray panel** (`TrayPanel`, window `tray-panel`):
The small window next to the tray icon, opened by a left click on it, with the task proposals and the sessions waiting for you (ADR-50), those asking for approval first, with their approval requests answered in the panel (ADR-66). A click on another entry opens it in the main window.
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

**Agent dialog** (`AgentDialog`, `Session.dialog`, `readAgentDialog`; API `answer-dialog`):
What Copilot CLI asks on a session's screen, read by the daemon from the screen image (ADR-66): an **approval** (run a command, change a file) with Copilot CLI's own options, which the tray panel and Home answer by typing the option's digit, or Esc for "Stop the agent", into the session; or a **question** from the agent (its form), only shown. An answer names the dialog by its id (its text and the wait it belongs to), and the daemon types nothing once the screen shows another one, or the same one asked again. Never sent to agents over MCP.
_Avoid_: popup, prompt (that is the text sent to an agent), permission request (Copilot CLI's internal name)

**Tool permission rule** (`toolPermissions` in `workspace.yaml`, `ToolPermissionRules`, `sessionToolPermissions`):
Patterns of Copilot CLI tools (`shell(git push)`, `write`) a session may use without asking (`allow`) or never (`deny`), for every session or for repos matching `repos`, given to each new session as `--allow-tool` and `--deny-tool` (ADR-66). By hand only.
_Avoid_: permission (without qualification), allowlist

**Session environment** (`SessionEnvironment`, `Session.environment`, `Mise.sessionEnv`; in the UI *Environment from mise*):
The variables mise sets where a session works (repo root, a task's worktree, or the projects folder), given to Copilot CLI over the user's environment; the session keeps only their names, and `problem` when mise refused its place (ADR-93).
_Avoid_: env file, profile

**Secret from mise** (`secretNames`, `SessionEnvironment.secrets`):
A variable of the session environment that mise redacts (`redact = true`, an age-encrypted value) or whose name looks like a secret; its value is masked, and the agent's tools do not get it unless it is in the agent secrets (ADR-93).

**Agent secrets** (`agentSecrets` in `workspace.yaml`, `SessionEnvironment.agentSecrets`):
The secrets from mise the agent's shell and local MCP servers get; every other one goes to Copilot CLI's `--secret-env-vars` (ADR-93). By hand only.

**Environment change** (`EnvironmentChange`, `Agents.environmentChange`; in the UI *The environment from mise changed*):
How the session environment mise would give a running session now differs from the one it started with: new, changed and removed names, and the secrets its tools would now get or no longer get; never values (ADR-119).

**Restart** (`Agents.restart`, `agentsApi.restart`; in the UI *Restart to apply*):
Stopping a running session and starting it again with the same conversation, place and view, so it gets the environment and settings of now; a task's session restarts as Resume does (ADR-119). Unlike Resume, which starts an ended task's session again.

**Session plugin** (`writeCopilotPlugin`):
A directory with `plugin.json` and `hooks.json` that the daemon gives Copilot CLI through `--plugin-dir`, so that hooks report the state of this one session only (ADR-17).
_Avoid_: plugin (without qualification), hook configuration

**Session instructions** (`writeSessionInstructions`, file `trackwall.instructions.md`):
The instruction file in the session directory that the daemon gives Copilot CLI through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`: the Trackwall version that started the session and where the user sees it, the session's role (the supervisor or a free session in the projects folder, a main session in the repo root, or a task session in its worktree with the task rules and `report_result` at the end) and the **MCP instruction** (`MCP_INSTRUCTIONS`, also the MCP server's `instructions`): when to reach for which Trackwall tool and where the documentation is (ADR-46). It changes neither the repo nor `~/.copilot`.
_Avoid_: system prompt (Copilot CLI builds it itself), repository instructions (those are files in the user's repo)

**Hook record** (`CopilotHookRecord`):
One call of a hook from the session plugin: the event, the time it was received and only the payload fields needed for the state and the hook output, and for the rest only their names (without the prompt, tool arguments and results). A line of `hooks.jsonl` and a marker in the recording.
_Avoid_: record (without qualification; that is a log line)

**Hook output** (`CopilotHookOutput`, `hookOutputFor`):
What the daemon answers a session plugin hook with and Copilot CLI acts on (ADR-85): empty, a block of `agentStop` whose reason becomes the next turn's message, or `additionalContext` of `postToolUse` added to the tool's result. It carries the daemon's prompt about what waits for the session.
_Avoid_: hook response, hook result

**Window title** (`windowTitle`):
The title an agent CLI sets with the OSC 0 / 2 sequence; in Copilot CLI it is a description of the current work. Shown next to the state, it is never the state.
_Avoid_: intention, intent

**Recording** (session recording, `session.cast`):
A session's output in the asciicast v2 format with markers for hook records, session keys and the exit code, from which the state can be computed again (`replayCopilotRecording`). Without the content of keyboard input.

**Copilot CLI reference** (`CopilotReference`, `test/fixtures/copilot/reference/<platform>.json`):
What the real Copilot CLI of the pinned version showed and sent in the contract tests, per system and anonymised: the hooks with their payloads, the window titles, the input box and the approval dialog. The fake Copilot CLI of the tests replays it, and the contract tests compare a live session with it, or take it anew with `TRACKWALL_RECORD=1` (`startRecorder`, ADR-67). A test fixture, not part of the product.
_Avoid_: recording (that is `session.cast`), snapshot

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

**Error journal** (`ErrorJournal`, the `error-journal` module, `errorJournalApi`; in the UI *Trackwall errors* in Settings):
Trackwall's own errors on this computer: the daemon's unexpected errors, the UI's and the desktop shell's, in `logs/errors.json` (ADR-94). Each is a **Trackwall error** (`TrackwallError`): source (`daemon`, `shell`, `ui`), area, kind, anonymized message, frames in Trackwall's code, count. Do not confuse with an error from logs (`LogError`), which comes from the output of the user's processes.
_Avoid_: crash log, telemetry, bug report (nothing is sent)

**Doctor** (`Doctor`, the `doctor` module, `doctorApi`; in the UI *Doctor* in Settings):
The checks of what Trackwall needs on this computer: the projects folder, every key of `workspace.yaml`, git, Copilot CLI and its trusted folders, mise, `gh` and `glab` signed in to the repo hosts (ADR-101). Each is a **doctor check** (`DoctorCheck`) with a state (`ok`, `warn`, `fail`), what was found and what to do. It only reads.
_Avoid_: health check (that is `GET /api/health`), diagnostics, setup wizard

**Config files** (`ConfigFiles`, the `config-files` module, `configFilesApi`; in the UI *Files* in Settings):
Every file and folder Trackwall reads or writes on this computer, grouped by **place** (`ConfigPlace`: Trackwall's state folder, the projects folder, Copilot CLI's folder). Each is a **config entry** (`ConfigEntry`, what it is for in `CONFIG_ENTRIES`) with a state (`present`, `missing`, `invalid`), and each key of `workspace.yaml` a **workspace key** (`WorkspaceKeyState`) with its value and whether it comes from the file or the default (ADR-108). It only reads.
_Avoid_: settings (the Settings view changes values; this one shows where they live), config dump

**Anonymization** (`anonymize`):
Replacing what names the computer, its user or their repos in a Trackwall error's message (paths, user and computer names, repo names, hosts, addresses, token shapes) with a label such as `<projects>` or `<host>`, before it is saved (ADR-94). Do not confuse with masking, which hides secret values in process output.

**`seq`**:
A global, increasing record number for all sources; every daemon run starts from the moment of its start, so numbers do not repeat. The cursor (`sinceSeq` in the API and in MCP tools) works for one source and for the whole workspace; `dropped` says that some records after the cursor were lost.

**Event** (`DaemonEvent`, `sessions.changed`, `mise.running.changed`, `repos.changed`, `cards.warmup.changed`):
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
The left panel of the dashboard: sessions that are waiting for you or have an error, then task proposals waiting for a decision (ADR-39), then repos that are not clean. Those sessions and repos always have a label on the scene, and with the scene labels `all` every other repo has one too; proposals are not on the scene, and a click opens them in the Sessions view.

**Dashboard snapshot** (`HomeModel`):
What the dashboard shows, computed by the UI from the daemon's responses and given to the scene whole on every change.
_Avoid_: snapshot alone (that is a topic snapshot of events).

**Layer** (`HomeRepo.layer`, `HomeModel.layerCount`):
A repo's level on the dashboard, the same column as in the "Overview" view: the longest path from a repo nobody uses (entries on one side, libraries on the other). A repo without connections has no layer (`null`).

**Repo kind** (`RepoKind`: `entry`, `gateway`, `backend`, `library`):
A repo's role in the graph computed from its layer: entry, gateway, backend, library.
_Avoid_: service (that is a process from the repo configuration). On the dashboard every kind has a different solid.

**Scene style** (`SceneStyle`: `holo`, `orbs`; "Holograms", "Orbs" in Settings):
How the dashboard draws repos and sessions on this computer (ADR-104): holograms with a different solid for every repo kind, or glowing orbs, lighter for a slow graphics card.
_Avoid_: theme (that is the colours of the UI).

**Scene labels** (`SceneLabelMode`: `all`, `needs-you`; "Every repo", "Only what needs you" in Settings):
Which objects on the dashboard have a label: every repo, or only what the "Needs you" queue lists (repos that are not clean, sessions waiting for you or with an error).

**Callout** (`layoutCallouts`, `scene-callout`):
A label on the scene: a plate beside its object, away from the middle of the ring, joined to it by a leader line; callouts that would cover each other are lifted apart.
