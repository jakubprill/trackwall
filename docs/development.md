# Development

Repo layout, running from source and tools for people who develop Trackwall. Project documentation (moving to English, ADR-43):

- [Features](https://jakubprill.github.io/trackwall/): the documentation site, source in `apps/docs`
- [Architecture](architecture.md)
- [Rules for agents and Definition of done](../AGENTS.md)
- [Glossary](../CONTEXT.md)
- [Releases](release.md)
- [Installation](https://jakubprill.github.io/trackwall/guide/install): the steps for users, on the documentation site

## Repo layout

| Path | What it is |
|---|---|
| `packages/protocol` | types and zod schemas shared by the daemon, the UI and the CLI; the docs site takes its address from it |
| `packages/daemon` | the daemon (Bun, Node-compatible code), built into a single binary; `src/modules/` are the modules from §4 of the architecture, `src/api/` and `src/mcp/` the transports, `src/platform/` system APIs, `src/infra/` the rest of the infrastructure; the root of `src/` holds only `main.ts` and `facade.ts`; `test/` the tests of `pnpm test` (Copilot CLI there is a fake), `contract/` the contract tests with the real Copilot CLI (ADR-67), `e2e/` the E2E tests of the UI in Chromium (ADR-71), `jvm/` the tests with real Java builds on the Spring Boot projects in `jvm/projects/` (ADR-72) |
| `packages/ui` | React + Tailwind + shadcn/ui, Vite; `src/views/<view identifier>/` are the views from the bar on the left (`home`, `repos`, `sessions`, `graph` for Overview, `settings`) and `tray-panel`, the page of the tray panel window (ADR-50), `src/components/` shared components, `src/lib/` logic without React and hooks; the root of `src/` holds only `main.tsx`, `App.tsx` and `index.css` |
| `packages/scene` | the 3D dashboard scene on Pawn (`@pawnjs/core` from npm): view model, "Orbit" layout, models |
| `apps/docs` | the feature documentation site (VitePress, ADR-56): `guide/` and one page per feature in `features/` written from `TEMPLATE.md`, the sidebar (and the groups of "All features") in `.vitepress/sidebar.ts`, the Trackwall look in `.vitepress/theme/`; the screenshots in `public/screenshots/`, taken by `scripts/screenshots.ts` from the demo daemon; the build also writes `llms.txt`, `llms-full.txt` and a Markdown copy of every page for AI tools; `.github/workflows/pages.yml` publishes it on GitHub Pages |
| `apps/desktop` | the Tauri 2 shell: windows (the main one and extra ones, translucent, ADR-11, ADR-49), tray and tray panel, system notifications and the global shortcut (ADR-50), starting and stopping the daemon |

## Running from source

Required: Node 22.12+, pnpm 10, Bun 1.4, and Rust for the desktop app (versions in `mise.toml`, `mise install` sets them up). On Windows the desktop app also needs Visual Studio Build Tools with the "Desktop development with C++" workload, which mise does not install.

With mise: `mise install`, then `mise run dev` (dependencies and development mode) or `mise run portable` (dependencies and a portable build into `out/`); `mise run setup` installs only the dependencies, `mise tasks` shows the list.

On Windows without Build Tools, Rust finds another `link.exe` on PATH (for example from coreutils or Git) and the Tauri build fails with a linker error. The UI in the browser (`pnpm dev`) works without them.

```sh
pnpm install
pnpm dev                       # daemon (bun --watch, state in .trackwall-dev/) + Vite at http://127.0.0.1:5173
pnpm --filter @trackwall/desktop dev   # the same in a Tauri window (state in ~/.trackwall-dev, separate from the release)
pnpm lint                      # Biome and knip (pnpm format fixes formatting)
pnpm test                      # tests of every package
pnpm test:contract             # the daemon with the real Copilot CLI (pinned version or `TRACKWALL_COPILOT_CLI`, downloaded once) against a scripted model; no account
pnpm test:e2e                  # the UI build, then four paths through it in Chromium on the daemon with the fake Copilot CLI
pnpm test:jvm                  # the daemon on real Spring Boot projects built by Maven and Gradle through mise; needs mise and network, takes minutes
pnpm --filter @trackwall/docs dev     # the documentation site under /trackwall/ (Vite prints the address; 5174 when `pnpm dev` holds 5173)
pnpm --filter @trackwall/docs build   # the site into apps/docs/dist; fails on a broken link between pages
```

### Contract tests with the real Copilot CLI

`pnpm test:contract` runs `packages/daemon/contract/*.contract.ts` (ADR-67). It downloads the native Copilot CLI binary of the version in `packages/daemon/scripts/copilot-cli.ts` from the npm registry (checked against the registry's sha512, kept in `packages/daemon/node_modules/.cache/copilot-cli`) and starts it from the daemon as a real session would, in BYOK mode: `COPILOT_OFFLINE=true` and `COPILOT_PROVIDER_BASE_URL` pointing at `contract/support/scripted-model.ts`, an OpenAI-compatible endpoint on 127.0.0.1 that gives the replies the test queued (`model.reply(...)`) and keeps every request. So no account, no network after the download and no model costs. Copilot CLI gets its own `COPILOT_HOME` in the test's state directory, which trusts the test folders. CI runs them on Linux, Windows and macOS in every PR (`.github/workflows/contract.yml`, called by `ci.yml`), and every night on the newest stable Copilot CLI on npm (`.github/workflows/nightly.yml`), which opens an issue "Contract tests fail on Copilot CLI <version>" when they fail on `main` and closes it on the next green night. A reference taken on such a version fails `copilot-reference.test.ts` until the PR raises `COPILOT_CLI_VERSION` to it. The tests start Copilot CLI with `COPILOT_AUTO_UPDATE=false`, because otherwise its binary hands over to the newest Copilot CLI unpacked on the machine (`~/.copilot/pkg` or the system cache), so a run on a newer version, or a newer installed Copilot CLI, would replace the pinned one unnoticed. To run them on another version locally, name it exactly: `TRACKWALL_COPILOT_CLI=1.0.104 pnpm test:contract`; the nightly workflow also runs by hand with a version (Actions → Nightly → Run workflow).

A contract test checks what the daemon relies on from Copilot CLI, not Trackwall's features: hook events and their payload fields, the approval dialog as the daemon reads it from the screen, `--allow-tool`/`--deny-tool`, the MCP tools over the session's HTTP entry (also behind a proxy), the session instructions in the prompt, flags like `--interactive=`. Feature tests stay in `test/` with the fake. The contract tests also compare a live session with the **Copilot CLI reference** of the system they run on (`test/fixtures/copilot/reference/<platform>.json`: the hooks with their payloads, the window titles, the input box and the approval dialog), which the fake Copilot CLI (`test/fixtures/fake-copilot-session.ts`) replays. When a contract test fails after raising `COPILOT_CLI_VERSION` (to the version a nightly issue names, for example), take the reference again with `TRACKWALL_RECORD=1 pnpm test:contract` followed by `pnpm format` (Linux locally; for macOS and Windows the CI run's `contract` job prints the reference it saw when it differs, which goes into the file before `pnpm format`; check that no path of the runner is left in it), and update the fake to any new behaviour in the same PR. `test/copilot-reference.test.ts` checks that every reference comes from the pinned version and reads as the daemon expects.

### E2E tests of the UI

`pnpm test:e2e` builds the UI and runs `packages/daemon/e2e/*.e2e.ts` (ADR-71). Each file starts the daemon of the session tests (`test/support/session-api.ts`: a real PTY, git and process groups, the fake Copilot CLI of `test/fixtures/fake-copilot-session.ts`, which replays the Copilot CLI reference) serving `packages/ui/dist`, and drives it in headless Chromium through Playwright's library, under `bun test` like every other test. They need Chromium for Playwright once: `pnpm --filter @trackwall/daemon exec playwright install --only-shell chromium` (on Linux add `--with-deps` for the system libraries). CI runs them on Linux, Windows and macOS in every PR, in the `e2e` job of `ci.yml`.

They cover four paths, each through the daemon, its WebSockets and a view: a session in a repo asking for approval, answered from the tray panel; a task proposal from a main session, edited and started in "Sessions"; an agent task created in the form, verified, commented on in "Changes", with the review reaching its agent; and Home in the main window as the Tauri shell shows it (`openDesktopWindow`: the window's origin, the CSP of `tauri.conf.json` and a fake `daemon_connection`), drawing the 3D scene and receiving the daemon's events with nothing refused by the CSP, and with the scene's chunk failing to load, a message in its place while the other views keep working. A change to the CSP, to a dependency of the scene or to how the UI reaches the daemon runs this one; the tests that open the daemon's own page see no CSP at all. A test reads what the user reads (the list, the tray panel, the terminal's rows that xterm.js draws in the page) and checks what the agent got through the MCP tools its session uses, as its bridge does. A new path belongs here only when it crosses the daemon and a view in a way the tests of `packages/ui/test` and of the daemon each see only one side of; the logic of a view stays in `packages/ui/src/lib` with its unit tests. Two things a test must respect: the fake Copilot CLI draws at a fixed width and does not redraw when the terminal shrinks, so the main window folds the supervisor panel to keep the terminal wider than the fake's screen; and a key for an approval goes in once the list shows "asking for approval", since a key the daemon reads before the request's hook counts as text typed into the input box.

### Tests with real Java builds

`pnpm test:jvm` runs `packages/daemon/jvm/java-projects.jvm.ts` (ADR-72): the daemon with real `mise` on two small Spring Boot projects copied into a projects folder as git repos, `orders` built by Maven and `checkout` built by Gradle (Kotlin DSL), where `checkout` calls `orders` through a `RestClient`, and `orders` also implements an interface the OpenAPI generator writes from its spec during the build (ADR-87). Through the MCP tools, as an agent uses them, the tests check what Trackwall reads from Java builds: the cards (apps, ports, endpoints with DTOs and from the spec, the HTTP client), `find_endpoint` with its caller and the spec's endpoint where the app serves it, `run_mise_task` with `get_test_results` on the Surefire and Gradle reports, `start_service` with the dependency from the graph and `call_endpoint` through both apps, `verify_task` on a task whose change breaks a test (Maven) or the compilation (Gradle), with the failed test from the report and the errors from the log (also through `get_errors`), and a task's service that fails to start, with Spring Boot's failure report. The unit tests in `test/` check the same features on handwritten files and logs, and stay the place for every case; these tests only show that real build tools still write what those files assume.

Each project's `mise.toml` names its JDK, Maven or Gradle and its tasks `dev` and `test`, as a repo in a user's workspace does, and the tests first trust it and run `mise install` like the Batch command's `tools` step. So a run needs `mise` on `PATH` and network: mise downloads the tools it does not have and Maven and Gradle the Spring Boot dependencies, which takes minutes the first time and seconds after that. Tools you already have can be given to mise with `mise link` (for example `mise link maven@3.9.11 /opt/maven`) instead of a download. The tests copy only the files git tracks in `jvm/projects/`, so a build run there by hand (ignored by `.gitignore`) does not reach them, and `checkout` builds with Gradle's daemon, as Gradle does by default, which the tests stop with `gradle --stop` at the end. The services listen on ports 18081 and 18082, which must be free.

CI runs them every night on Linux, Windows and macOS (`.github/workflows/jvm.yml`, called by `nightly.yml`), outside `CI ok`, and opens an issue "Tests with real Java builds fail" when they fail on `main`, closed by the next green night; on a PR they run when it touches the daemon, the protocol or the dependencies (the `paths` of `jvm.yml`), and by hand from Actions. The workflow installs the mise version it names; Dependabot proposes new Spring Boot and plugin versions for the projects, on which the tests run before the merge. A change that makes Trackwall read something new from Java builds (a log line, a report location, a Spring annotation) adds it to a project here when a real build shows it, besides the unit test.

The daemon alone with the UI in the browser, without Tauri:

```sh
pnpm build
bun packages/daemon/src/main.ts --ui
```

A daemon on a made-up shop of twenty repos, with sessions in every state, task proposals, agent tasks and running services, for demos and the screenshots of the documentation site. Copilot CLI is replaced by a stand-in (`packages/daemon/scripts/demo/copilot.ts`) that never calls a model; the services need `mise` and Node on PATH:

```sh
pnpm --filter @trackwall/ui build
pnpm --filter @trackwall/daemon demo <empty state directory>   # prints the address of the UI
pnpm --filter @trackwall/docs screenshots                      # the pictures in apps/docs/public/screenshots, from the same demo
pnpm --filter @trackwall/docs screenshots task-review          # only the named pictures
```

The screenshots need Chromium for Playwright once: `pnpm --filter @trackwall/docs exec playwright install chromium`.

The same daemon also runs under plain Node, without Bun (ADR-1): `pnpm --filter @trackwall/ui build`, then `pnpm --filter @trackwall/daemon start:node`.

## Portable build

```sh
pnpm build:desktop   # UI, the daemon as a binary, Tauri without an installer
pnpm portable        # out/trackwall-<version>-windows-x64.zip or out/trackwall-<version>-macos-<arch>.zip
```

Windows: the zip contains `trackwall.exe`, `trackwall-daemon.exe` and `ui/`. Unpacking it and running `trackwall.exe` is enough; state goes to `%USERPROFILE%\.trackwall`. Without WebView2, `trackwall.exe` shows a message, and `trackwall-daemon.exe --ui` opens Trackwall in the browser. The files are not signed, so SmartScreen shows a warning (signing with Azure Trusted Signing is planned before publication, §9 of the architecture).

macOS: the zip contains an unsigned `Trackwall.app`; open it the first time with right click > Open or `xattr -dr com.apple.quarantine Trackwall.app`.

Every CI run (PR, push to `main`, manual run) publishes both archives as artifacts.

## Icons

The icon sources are `apps/desktop/assets/icon.svg` (the app icon; the documentation site has a copy without the comment in `apps/docs/public/logo.svg`, kept equal by `apps/docs/test/theme.test.ts`) and `apps/desktop/assets/tray-icon.svg` (the single-colour tray mark). After changing either of them:

```sh
pnpm --filter @trackwall/desktop icons   # icons from bundle.icon in tauri.conf.json, the macOS tray template and the UI favicon
```

The generated files go into the repo together with the changed SVG. `tauri icon` writes `icon.icns` with its entries in a different order every time, so discard a changed `icon.icns` after a run without an SVG change (`git checkout -- apps/desktop/src-tauri/icons/icon.icns`).

## Copilot CLI with the MCP server from source

The user guide (`apps/docs/guide/connect-copilot-cli.md`) shows the command for an installed Trackwall. From source, Copilot CLI starts the bridge with Bun:

```sh
copilot mcp add trackwall -- bun --no-env-file --config=<trackwall>/packages/daemon/bunfig.toml <trackwall>/packages/daemon/src/main.ts mcp-stdio --home <state directory>
```

Checking it by hand needs a signed-in Copilot CLI. Start Trackwall with the projects folder set, run the command from "Settings > Agents", run `copilot` in the projects folder, check in `/mcp` that `trackwall` is connected with the tools `list_repos`, `get_repo`, `get_repo_card`, `tail`, `get_errors`, `get_test_results`, `who_calls`, `subgraph_for`, `find_endpoint`, `search_code`, `list_sessions`, `get_session`, `get_task_changes`, `propose_task`, `report_result`, `wait_for_session`, `run_mise_task`, `stop_mise_task`, `wait_for_mise_task`, `list_running_mise_tasks`, `start_service`, `stop_service`, `list_services` and `call_endpoint`, ask for the repo list, then for the details of one of them (README, mise tasks), for its card (for example "Which packages does orders-bff use?") and for who uses it ("Which repos does a change in core-lib affect?", "Who calls GET /api/orders/{id}?"), for code across many repos ("Where do the Java repos use RestTemplate?"), and with a session from the "Sessions" view running, for Trackwall sessions ("Which Trackwall sessions are waiting for me?"), then for commissioning a task ("Propose a task in orders-bff that adds a health endpoint, then wait for it"): the proposal should appear in the "Sessions" view, and after "Start task" the task session should start working at once, not wait for you. The daemon log (the `pnpm dev` terminal or `trackwall-daemon`) shows every call as `[mcp] list_repos: ok in … ms`.

## Recording Copilot CLI sessions

A prototype of task state detection (ADR-17), for collecting recordings. The script runs Copilot CLI in a PTY the same way the daemon does in the "Sessions" view, shows it in the current terminal, records it and computes the state (`Working`, `Input`, `Approval`…). It requires Bun and an installed, signed-in `copilot` on `PATH` (on Windows both `copilot.exe` and `copilot.cmd` from `npm install -g`). Run it in the directory of the repo the agent should work in, with `bun --no-env-file`, so that Bun does not load the repo's `.env` into the Copilot CLI environment (Bun still reads `bunfig.toml` from the current directory, so in a repo with a `bunfig.toml` run the script with `--config` pointing to another file):

```sh
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record                              # a plain interactive session
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record -- -i "Describe this repo"   # arguments after -- go to copilot
bun <trackwall>/packages/daemon/scripts/copilot-record.ts replay <directory>/session.cast                    # state computed again from the recording
```

After Copilot CLI exits, the script prints the list of state changes and the recording directory (by default `~/.trackwall/recordings/<time>` or `$TRACKWALL_HOME/recordings/<time>`, another one with `--out`): `session.cast` (asciicast v2, playable in asciinema), `states.jsonl`, `hooks.jsonl` and `plugin/` with the hooks passed through `--plugin-dir`. Live states can be watched in a second terminal: `tail -f <directory>/states.jsonl` or in PowerShell `Get-Content -Wait <directory>\states.jsonl`. A recording contains everything that was on the screen, so it must be anonymized before it is added to the repo as a fixture. Keyboard input (only each single Enter, Esc, Ctrl+C or digit is stored, as the kind of key, without the rest of the input), prompts, and tool arguments and results from hooks are not stored, but the title and text of a notification (each up to 200 characters) are, and for an approval request they contain the command or the full path the agent asks about. To record an approval request, ask the agent to write a file outside the session directory: Copilot CLI 1.0.103 runs simple commands like `ls` or `date` without asking.
