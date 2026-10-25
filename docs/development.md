# Development

Repo layout, running from source and tools for people who develop Trackwall. Project documentation (moving to English, ADR-43):

- [Features](https://jakubprill.github.io/trackwall/): the documentation site, source in `apps/docs`
- [Architecture](architecture.md)
- [Rules for agents and Definition of done](../AGENTS.md)
- [Glossary](../CONTEXT.md)
- [Releases and installation](release.md)

## Repo layout

| Path | What it is |
|---|---|
| `packages/protocol` | types and zod schemas shared by the daemon, the UI and the CLI |
| `packages/daemon` | the daemon (Bun, Node-compatible code), built into a single binary; `src/modules/` are the modules from §4 of the architecture, `src/api/` and `src/mcp/` the transports, `src/platform/` system APIs, `src/infra/` the rest of the infrastructure; the root of `src/` holds only `main.ts` and `facade.ts` |
| `packages/ui` | React + Tailwind + shadcn/ui, Vite; `src/views/<view identifier>/` are the views from the bar on the left (`home`, `repos`, `sessions`, `graph` for Overview, `daemon`, `settings`) and `tray-panel`, the page of the tray panel window (ADR-50), `src/components/` shared components, `src/lib/` logic without React and hooks; the root of `src/` holds only `main.tsx`, `App.tsx` and `index.css` |
| `packages/scene` | the 3D dashboard scene on Pawn (`@pawnjs/core` from npm): view model, "Orbit" layout, models |
| `apps/docs` | the feature documentation site (VitePress, ADR-56): `guide/` and one page per feature in `features/`, the sidebar in `.vitepress/config.ts`, the Trackwall look in `.vitepress/theme/`; `.github/workflows/pages.yml` publishes it on GitHub Pages |
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
pnpm --filter @trackwall/docs dev     # the documentation site under /trackwall/ (Vite prints the address; 5174 when `pnpm dev` holds 5173)
pnpm --filter @trackwall/docs build   # the site into apps/docs/dist; fails on a broken link between pages
```

The daemon alone with the UI in the browser, without Tauri:

```sh
pnpm build
bun packages/daemon/src/main.ts --ui
```

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

## Recording Copilot CLI sessions

A prototype of task state detection (ADR-17), for collecting recordings. The script runs Copilot CLI in a PTY the same way the daemon does in the "Sessions" view, shows it in the current terminal, records it and computes the state (`Working`, `Input`, `Approval`…). It requires Bun and an installed, signed-in `copilot` on `PATH` (on Windows both `copilot.exe` and `copilot.cmd` from `npm install -g`). Run it in the directory of the repo the agent should work in, with `bun --no-env-file`, so that Bun does not load the repo's `.env` into the Copilot CLI environment (Bun still reads `bunfig.toml` from the current directory, so in a repo with a `bunfig.toml` run the script with `--config` pointing to another file):

```sh
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record                              # a plain interactive session
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record -- -i "Describe this repo"   # arguments after -- go to copilot
bun <trackwall>/packages/daemon/scripts/copilot-record.ts replay <directory>/session.cast                    # state computed again from the recording
```

After Copilot CLI exits, the script prints the list of state changes and the recording directory (by default `~/.trackwall/recordings/<time>` or `$TRACKWALL_HOME/recordings/<time>`, another one with `--out`): `session.cast` (asciicast v2, playable in asciinema), `states.jsonl`, `hooks.jsonl` and `plugin/` with the hooks passed through `--plugin-dir`. Live states can be watched in a second terminal: `tail -f <directory>/states.jsonl` or in PowerShell `Get-Content -Wait <directory>\states.jsonl`. A recording contains everything that was on the screen, so it must be anonymized before it is added to the repo as a fixture. Keyboard input (only each single Enter, Esc, Ctrl+C or digit is stored, as the kind of key, without the rest of the input), prompts, and tool arguments and results from hooks are not stored, but the title and text of a notification (each up to 200 characters) are, and for an approval request they contain the command or the full path the agent asks about. To record an approval request, ask the agent to write a file outside the session directory: Copilot CLI 1.0.103 runs simple commands like `ls` or `date` without asking.
