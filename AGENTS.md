# Trackwall: rules for agents

Trackwall is written mostly by agents, and a human reads the code now and then. Every rule below exists so that the next agent, or a person looking in from the side, can understand a change and trust it without asking. When a rule and intuition disagree, the rule wins. When a rule is wrong, change it here in the same PR and say why.

Repo map and running from source: `docs/development.md`. Features: the documentation site in `apps/docs` (one page per feature, published on GitHub Pages). Architecture and module boundaries: `docs/architecture.md`. Glossary: `CONTEXT.md`. Releases: `docs/release.md`.

In this file "agent" means an agent writing Trackwall code. An agent that Trackwall runs in a task is called a "task session" here.

## Definition of done

A change is done when it meets every point, not when it compiles:

1. **It works and has tests, at every layer it touches.** No new feature, behaviour change or bug fix is merged without tests that would fail without it; a bug fix starts with such a test. Each layer has its own kind, and a feature gets every one that applies:
   - **Logic** (a rule, a parser, a state, a view's logic in `packages/ui/src/lib`): a unit test in the package's `test/` directory (`bun test`).
   - **A daemon flow** (an API action, an MCP tool, a session, task or process): a test in `packages/daemon/test/` through the real facade, a real child process for `procs` and `logs`, real git and the fake Copilot CLI; `cargo test` for the Tauri shell.
   - **Whatever the daemon relies on from Copilot CLI** (a hook event or payload field, a flag or environment variable, a screen pattern such as the approval window, how it loads MCP servers and instructions): a contract test in `packages/daemon/contract/` that runs the real Copilot CLI against a scripted model (`pnpm test:contract`, ADR-67), and the fake Copilot CLI of `test/` gets the same behaviour in the same PR (a difference a contract test finds in existing behaviour is fixed in its own PR and named in §10 of the architecture until then). A feature test with the fake alone proves only that the daemon agrees with the fake.
   - **A key path through the UI** (a session and its approval, a task proposal, an agent task with its review; ADR-71): its E2E test in `packages/daemon/e2e/` (`pnpm test:e2e`) keeps passing, and a change to what the user sees or does on that path changes the test with it. Other UI features need no E2E test: their logic gets unit tests and their daemon side flow tests. A new path joins the E2E tests only when it crosses the daemon and a view in a way the tests of either side cannot see.

   The PR description names the tests added for each layer, or says why a layer does not apply.
2. **It works on Windows and macOS.** System-dependent code has a test that CI runs in the `windows-latest` + `macos-latest` matrix. CI checks Linux, Windows and macOS on every PR (ADR-22); a PR is ready when the `CI ok` check on its last commit is green. Whatever CI cannot check (WebView2, SmartScreen, a real Windows machine outside CI, a real model) goes into the PR as "to check manually", each item with the reason it cannot be automated; "with a real Copilot CLI session" is not such a reason when a contract test can show it.
3. **Locally,** `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, and when the change touches one of the key paths through the UI, so does `pnpm test:e2e`, and when the change touches `apps/desktop`, the daemon build or packaging, so do the steps of the `desktop` job in `.github/workflows/ci.yml`, and when it touches `apps/docs`, the documentation site build (section "Commands"). CI confirms, it does not hunt for bugs.
4. **Documentation describes the new behaviour in the same PR** (section "Documentation").
5. **Nothing company-specific** in code, tests, fixtures, documentation or commits (section "Nothing company-specific in the repo").
6. **The pre-PR review is done** (section "Pre-PR review"): findings fixed or rejected with a reason.
7. **The PR description** follows `.github/pull_request_template.md`: what changed for the user (before/after), why, how it was checked and what is left to check manually.

Do not weaken checks to get green: no skipped or deleted tests, no `biome-ignore` without a reason in the same comment, no rule disabled in `biome.json`, no `--no-verify`, no `continue-on-error` on a job that is meant to block. If a rule rightly gets in the way, change it in the same PR and say why.

## Pre-PR review

Before opening a PR, and before every later push with new code, the change goes through a ruthless code review. Three independent reviews, each run separately, with their findings merged into one list:

- `/thermo-nuclear-code-quality-review` (skill in `.claude/skills/`, a copy from the Thermos plugin in `cursor/plugins`, MIT license next to it): structure, abstractions, file growth, "code judo". The original has `disable-model-invocation: true`; the copy drops that line so that an agent can run it on its own. When updating from the original, remove it again.
- `/code-review`: correctness bugs, every finding verified.
- `mattpocock-skills:code-review`: conformance with the documented rules (this file, `CONTEXT.md`, `docs/architecture.md`) and with what the task asked for.

The first round runs at the highest level (`/code-review max`), later rounds on the diff of the fixes (`high`). You are done when a round brings no confirmed finding to fix; after three rounds, whatever is left goes into the PR description as knowingly left. If one of the skills is missing from the environment, run that review through a separate subagent with the same scope and say so in the PR. In the PR description: how many rounds, what was fixed, what was rejected and why.

## Documentation

- **`docs/architecture.md` is the only architecture document.** A change to a module boundary, protocol, data model or flow updates the matching section in the same PR. Search the whole document for the old behaviour, not just the obvious section.
- **Decisions go to §12 as ADRs.** A new ADR has a number, a date, a one-sentence decision, the reasoning and what would reverse it. A spike result or a clarification is appended to the existing ADR (like the spike findings in ADR-1). A reversed decision is not deleted: a new ADR, and the old one gets the note "superseded by ADR-N".
- **A new domain term goes into `CONTEXT.md`** together with its identifier in code. From then on that one word is used in code, UI, MCP tools and documentation.
- A change to commands, required tools or repo layout updates `docs/development.md` (and the "Commands" section below if it concerns the Definition of done). A new or changed feature updates its page in `apps/docs/features/`; a new feature gets a new page from `apps/docs/TEMPLATE.md` and an entry in `apps/docs/.vitepress/sidebar.ts` (ADR-56). Those pages are for people using Trackwall: what they see and do, in plain words, without ADRs, module names or history; the why stays in `docs/architecture.md`. A change to the release process updates `docs/release.md`.
- `README.md` is deliberately short (ADR-32): what Trackwall is, that it is an early version, where the releases are and a link to the installation instructions. Do not add feature descriptions or instructions to it.

## Language

- **Everything in the repo is in English** (product since ADR-32, the rest since ADR-43): product texts (UI, tray and windows of the desktop shell, daemon messages and logs, validation messages, MCP tool descriptions and instructions, CLI messages), `README.md`, `SECURITY.md`, issue forms in `.github/ISSUE_TEMPLATE/`, `README.txt` in the portable build, release notes in `docs/release-notes/`, documentation in `docs/`, ADRs, this file, `CONTEXT.md`, comments, commit messages, PR titles and descriptions, test names and developer scripts (`scripts/` of the packages). Interface words come from `CONTEXT.md`.
- Identifiers, API error codes (`error.code`), event names and MCP tool names are in English, also inside Polish text that has not been migrated yet.
- **The migration is staged** (ADR-43): Polish text that is still in the repo is translated in dedicated PRs, one document or one package at a time. Write new and rewritten text in English; do not translate untouched Polish text in passing, so that your PR does not conflict with a migration PR. History stays as it is: old commits, PR descriptions and `docs/release-notes/v0.2.0.md`.

## Nothing company-specific in the repo

The repo is meant to be published as open source (header of `docs/architecture.md`), and everything company-specific lives in the workspace configuration (ADR-7). Never put into code, tests, fixtures, documentation or commits the name of a company, a client, internal hosts, GitLab addresses, repo names or topics from work. Company-specific rules come in as parameters from the workspace. Session recordings and logs used as fixtures are anonymized before they are committed.

## Security

- **The daemon listens only on `127.0.0.1`.** Every HTTP, WebSocket and MCP request passes a `Host`/`Origin` check and, apart from `GET /api/health` and the static UI files, also requires the token, compared in constant time. This is done by `handle()` in `packages/daemon/src/api/server.ts` with the help of `api/guard.ts`; a new transport uses the same functions, not its own.
- **Everything from outside is untrusted**: request bodies, MCP tool arguments, configuration files, process output, files from the user's repos. It comes in through a zod schema (`safeParse` at the point of entry; API contract schemas in `packages/protocol`).
- **The daemon builds commands from configuration, never from text sent by a task session** (§1.2). Processes of services, mise tasks and task sessions start only through the `procs` module, in a group, with a working directory checked against the root of the repo or worktree (for the supervisor, the projects folder, ADR-58).
- **Secrets do not reach task sessions or logs**: values are masked before they are written to the buffer, MCP tools answer "set / missing", environment variables do not go into the audit, error messages or fixtures.
- No MCP tool changes the daemon configuration, autostart or the list of connected agents; only the UI does that.
- An agent does not push tags, create releases or change repo settings. A human makes the release following `docs/release.md`.
- A gap you do not close in the PR goes into §8 of the architecture and is listed in the PR description.

## Windows first

- Paths only through `node:path` and `node:os`; no joining with `/` and no assuming that the home directory is `~`. Remember the 260-character limit and files locked by running processes.
- Scripts in the repo are in TypeScript (`bun <package>/scripts/...`), not bash or PowerShell, so that they behave the same on both systems. Exception: `run:` steps in GitHub Actions workflows.
- Process state is observed, not assumed (§1.3): "stopped" only after checking that the whole group is dead and the port is free. `taskkill` and an exit code are not enough.
- No symbolic links in the repo: on Windows git turns them into text files by default.
- `fetch` in Bun routes `127.0.0.1` through `HTTP_PROXY`. In the daemon and its scripts, loopback calls use `loopbackRequest` from `packages/daemon/src/infra/loopback.ts`; when it is needed outside the daemon (the `ws` CLI), it moves to a separate Node/Bun-only package, not to `protocol`, which must run in the browser.

## Code readable by agents and humans

- **Names say what a thing is in the domain**, with the same word as `CONTEXT.md`, the UI and the MCP tools. One concept, one name.
- **The module boundaries from §4 are hard.** A daemon module does not import another module directly, only through the facade; a new dependency between modules requires a change to the table in §4. The UI, the scene and the CLI do not import `@trackwall/daemon`; shared code comes only from `@trackwall/protocol`, and the UI additionally takes the dashboard scene from `@trackwall/scene` (ADR-33), which itself knows only `protocol` and Pawn. Daemon infrastructure files (`main.ts`, `infra/`, `platform/`) are not modules and hold no domain state.
- **Every file has its place** (`docs/development.md`, "Repo layout"): in the daemon a module in `src/modules/<module>/`, a transport in `src/api/` or `src/mcp/`, system APIs in `src/platform/`, the rest of the infrastructure in `src/infra/`; in the UI a component of one view in `src/views/<view identifier>/`, a component of several views in `src/components/`, logic without React and hooks in `src/lib/`. Only entry points sit in the root of `src/`. `docs/development.md` keeps the lists of entry points and views, and the test `apps/desktop/test/layout.test.ts` guards them.
- **Types are the contract and come from code**: from values, from zod schemas (`z.infer`). No `any`. Instead of `!`, an explicit check and an exception with a description. An `as` assertion is a claim the compiler will not check: external data (`JSON.parse`, HTTP responses, files, CLI arguments) is never cast, only parsed with a schema. Otherwise `as` only where a library type is wider than what is known at that point (`server.address() as AddressInfo`, an error in `catch` as `NodeJS.ErrnoException`), and in tests to build fakes.
- **Small functions and single-purpose files.** A file that does two things becomes two files.
- **One place for every rule.** Before writing a helper, look for an existing one. Duplicated logic is a bug waiting for the copies to drift apart.
- **Comments explain why, not what.** A non-obvious module starts with a short comment: what it is for, what it guarantees, where it is described (architecture section).
- **Explicit over clever**: no magic strings shared between files (export a constant), no hidden global state, no silent defaults for something that must be set.
- **Delete dead code** instead of commenting it out.
- **File names**: kebab-case (`system-open.ts`), React components in PascalCase (`DaemonPanel.tsx`). Exception: shadcn/ui components in `components/ui/` keep the names the generator gives them (`button.tsx`).
- **npm dependencies at exact versions** (no `^` or `~`; `.npmrc` has `save-exact=true`, so `pnpm add` takes care of it). Do not add a dependency for something a few lines of code can do. A native addon requires checking that it works in `bun build --compile` on both systems (a spike in a separate PR, findings in an ADR, like ADR-1).
- **Tests read like documentation**: a test name is a sentence describing the behaviour, and the test shows the input and the expected result without helpers that hide them.
- **Rules are enforced by a tool wherever possible**: a linter rule holds better than a sentence in this file. When you repeat the same finding in reviews, turn it into a rule. Today these guard the code:
  - Biome (`biome.json`): the `recommended` set plus a ban on `!` and `any`, a function complexity limit (15), import cycles, unhandled promises, kebab-case file names (PascalCase only for `.tsx` in `packages/ui/src`), `@trackwall/daemon` imports only in the daemon, in the UI the `@trackwall/scene` root only in the dashboard canvas (the rest uses `@trackwall/scene/model`), Node modules (`node:*`) banned in `packages/protocol/src`, `packages/scene/src` and `packages/ui/src` (browser code), daemon module boundaries (§4: a module does not import a neighbouring module, and code outside `src/modules` reaches them only through `src/facade.ts`);
  - knip (`knip.json`): unused files, exports and dependencies;
  - `rustfmt.toml` and `cargo clippy -D warnings` for the Tauri shell;
  - the test `apps/desktop/test/toolchain.test.ts`: the same tool versions in `mise.toml` and the workflows;
  - the test `apps/desktop/test/layout.test.ts`: the contents of the `src/` root of the daemon and the UI, and the view folders;
  - the test `apps/desktop/test/biome-config.test.ts`: the ban on `bun` imports and the global `Bun` applies everywhere in the daemon outside `platform/` (Biome does not merge override options, so the ban is repeated in several places);
  - Biome's `noRestrictedGlobals` and the test `apps/desktop/test/ui-dialogs.test.ts`: no `alert` or `confirm` in the UI, which the Tauri dialog plugin replaces (ADR-51);
  - the test `apps/docs/test/pages.test.ts`: every feature page follows `apps/docs/TEMPLATE.md` (frontmatter, title and lede, sections), is in the sidebar under its title, the home page cards repeat the page descriptions, and no page of the site cites an ADR or links into `docs/`;
  - the test `apps/docs/test/theme.test.ts`: the documentation site's dark theme, fonts and logo are copies of the app's tokens and icon (ADR-16, ADR-56);
  - the test `packages/ui/test/design-tokens.test.ts`: UI components without raw colours or arbitrary appearance values, only tokens from `index.css` (ADR-16);
  - daemon compatibility with Node (ADR-1): `erasableSyntaxOnly` in the `tsconfig.json` of the daemon and `protocol`, `useImportExtensions` in Biome for their `src` (also in `packages/scene/src`), the ban on Bun APIs in the daemon outside `platform/`, and daemon process tests under Bun and under Node.

  No tool guards `as` casts on external data, so the review does.

## Commands

The full description of how to run things is in `docs/development.md`. For the Definition of done:

```sh
pnpm lint              # Biome (format, lint, import order; pnpm format fixes them) and knip
pnpm typecheck
pnpm test              # bun test in every package
pnpm test:contract     # the daemon with the real Copilot CLI against a scripted model (ADR-67); CI runs it on every PR and nightly on the newest Copilot CLI (`nightly.yml`), run it locally when the change touches sessions, tasks, hooks or MCP
pnpm test:e2e          # the UI build, then the key paths through it in Chromium on the daemon with the fake Copilot CLI (ADR-71); CI runs it on every PR, run it locally when the change touches one of the key paths (Definition of done, point 1)

# when the change touches apps/desktop, the daemon build or packaging (the `desktop` job in CI; cargo fmt also in `check`):
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
pnpm build:desktop
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun packages/daemon/scripts/smoke.ts apps/desktop/src-tauri/target/release/trackwall-daemon
pnpm portable

# when the change touches apps/docs (a broken link between pages fails the build; the `check` job in CI runs it too):
pnpm --filter @trackwall/docs build
```

Tool versions are in `mise.toml` (`mise install`), which also has the `setup`, `dev` and `portable` tasks. The workflows have them in `env`, and the `.github/actions/setup` action installs them in the jobs that build and test (the audit needs only pnpm and Node); a version change goes into `mise.toml` and every workflow that sets it at once (`ci.yml`, `release.yml`, and Node and Bun in `pages.yml` and `contract.yml`; a test guards this).

## Commits and PRs

- Work goes through a PR to `main`, never a push straight to `main`.
- One topic per PR. Do not mix refactoring with a behaviour change unless the refactoring is needed for it.
- Commit messages and PR titles in the imperative mood ("Add…", "Resolve…"). History before ADR-43 is in Polish ("Dodaj…").
- The version is bumped only at release, in three places at once, together with a release note in `docs/release-notes/` (`docs/release.md`).
