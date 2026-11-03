---
title: Run in a dev container
description: Run Trackwall next to your repos in a Linux dev container and use it from the browser or the desktop app on your computer.
---

# Run in a dev container

Run Trackwall next to your repos in a Linux dev container and use it from the browser or the desktop app on your computer.

Where security software checks every program that starts and every file it opens, git and builds can be slow on Windows. Inside a Linux container whose files live in a Docker volume, the same work is much faster. Trackwall can run there too: everything that touches your repos (git, mise tasks, services, Copilot CLI sessions and the MCP server) runs in the container, and you use Trackwall from the browser or the desktop app on your computer through a forwarded port.

This page uses VS Code's Dev Containers extension. Any container works the same way as long as port forwarding keeps the port number.

## What you need

- Docker (Docker Desktop on Windows or macOS) and VS Code with the Dev Containers extension.
- Repos cloned into a Docker volume, not a folder of your computer mounted into the container: a mounted folder is as slow as before, and the [doctor](/features/doctor) warns about it.
- A Linux image with git and curl, on x86_64 or arm64. Debian or Ubuntu is the simplest; Alpine is not supported.

## Set up the container

A `.devcontainer/devcontainer.json` that keeps the repos, Trackwall's state, the Copilot CLI sign-in and your mise config (with the age key) in volumes, so they survive a rebuild of the container:

```json
{
  "name": "workspace",
  "image": "mcr.microsoft.com/devcontainers/base:debian",
  "workspaceMount": "source=workspace-repos,target=/workspaces,type=volume",
  "workspaceFolder": "/workspaces",
  "mounts": [
    "source=workspace-trackwall,target=/home/vscode/.trackwall,type=volume",
    "source=workspace-copilot,target=/home/vscode/.copilot,type=volume",
    "source=workspace-mise,target=/home/vscode/.config/mise,type=volume"
  ],
  "features": {
    "https://github.com/jakubprill/trackwall/releases/download/v<version>/devcontainer-feature-trackwall.tgz": {}
  },
  "forwardPorts": [7700],
  "portsAttributes": {
    "7700": { "label": "Trackwall", "requireLocalPort": true, "onAutoForward": "silent" }
  },
  "containerEnv": {
    "NO_PROXY": "127.0.0.1,localhost,host.docker.internal",
    "TRACKWALL_HOME": "/home/vscode/.trackwall",
    "TRACKWALL_DEVCONTAINER_HOST_FOLDER": "${localWorkspaceFolder}"
  },
  "postCreateCommand": "sudo chown -R vscode:vscode /workspaces /home/vscode/.trackwall /home/vscode/.copilot /home/vscode/.config/mise",
  "shutdownAction": "none"
}
```

- `features` adds Trackwall to your own image: replace `<version>` with the version of the desktop app you use, for example `0.6.0`. It installs Trackwall of that version, checked against the checksum the release wrote into it, and starts it every time the container starts. The address with its version is what you trust: it is Trackwall's own release on GitHub.
- A new volume belongs to `root`, so `postCreateCommand` hands the folders to the container's user.
- The Feature also runs the container with an init process, which cleans up the processes a stopped session leaves behind; without it Trackwall can report that a stopped session's processes are still running. Dev Containers applies it when it creates the container, so a container you start another way, for example with `docker run` or Docker Compose, needs `--init` (`init: true` in Compose) for the same reason.
- `TRACKWALL_HOME` tells the desktop app where Trackwall keeps its state in the container.
- `requireLocalPort` keeps the forwarded port at 7700 on your computer. Keep VS Code's `remote.localPortHost` at its default, `localhost`: with `allInterfaces` other computers on your network reach the forwarded port. Trackwall accepts a page only from `127.0.0.1:<port>` or `localhost:<port>` with the port it listens on, so a forward to another number does not load.
- `TRACKWALL_DEVCONTAINER_HOST_FOLDER` tells Trackwall which folder on your computer the container was opened from, so "Open in VS Code" opens the same kind of window as opening that folder in a container yourself, with the extensions and settings of this `devcontainer.json`. Without it, VS Code attaches to the running container without them. Use it when you open the container from a folder on Windows or macOS; from a folder inside WSL it may not open.
- `shutdownAction` keeps the container running when you close its last VS Code window. Trackwall and its sessions live in the container, and by default VS Code stops the container with its last window, which stops every running session; "Open in VS Code" in Trackwall can replace or close that window too. The container then runs until you stop it in Docker or Rancher Desktop (`docker stop <container name>`), and its sessions keep working while no window is open. VS Code forwards port 7700 only while one of its windows is open on the container, so Trackwall's page and the desktop app reach it again when you open one; a session waiting for your approval waits until then.
- Behind a proxy, set `HTTPS_PROXY` and `HTTP_PROXY` in `containerEnv` too, and keep `NO_PROXY` as above. A proxy that replaces certificates also needs its certificate in the image, and `NODE_EXTRA_CA_CERTS` pointing at it in `containerEnv`, because Copilot CLI does not read the system's certificates; the [doctor](/features/doctor) names the file when the image already has it.
- The container's clock runs in UTC, so times in logs, `git log` and builds are an hour or more off from yours. Add your time zone to `containerEnv`, for example `"TZ": "Europe/Berlin"`, and rebuild the container. The time zone names come from the `tzdata` package, which the Dev Containers base images have; in an image of your own, install it if `date` in the container still says UTC.

## Start Trackwall

Rebuild the container ("Dev Containers: Rebuild Container" in VS Code). From then on Trackwall starts with the container, on port 7700, and starts again by itself if it crashes. From 0.5.17 it starts also when the container starts without VS Code, for example after `docker restart` or from Docker or Rancher Desktop; with 0.5.16 and older, run `trackwall-container start` in the container then. Trackwall then starts before VS Code connects, so keep its settings, such as `TRACKWALL_HOME` and a proxy, in `containerEnv`, not `remoteEnv`. A Docker Compose dev container started with `docker compose up` instead of VS Code does not start Trackwall by itself. Then, in a terminal of the container:

1. Install [mise](https://mise.jdx.dev/getting-started.html) as its guide describes, then Copilot CLI with it: `mise use -g node@22 npm:@github/copilot`. Trackwall finds tools installed with mise without further setup.
2. Point Trackwall at the repos: in Settings › Workspace choose `/workspaces`, or run `echo "projectsDir: /workspaces" > ~/.trackwall/workspace.yaml` before the first start.
3. Print the address with its token: `trackwall-container address`, and open it in the browser on your computer.
4. Sign in to Copilot CLI once: run `copilot`, type `/login` and follow the steps in your browser. The sign-in stays in the `workspace-copilot` volume.

The browser keeps the token for that address, so a bookmark of `http://127.0.0.1:7700` and a new tab open Trackwall without it. The token changes every time Trackwall starts: after a restart, open or reload the page, and it asks for the address; print it again as in step 3 and paste it there. Trackwall's output goes to `~/.trackwall/logs/daemon.log` in the container; look there when it does not answer. It stops when the container stops, or when you stop it from the app; with `shutdownAction` set as above, closing VS Code does not stop the container.

`trackwall-container start` is safe to run at any time: it starts Trackwall only when it does not run, and prints one line of JSON, for example `{"ok":true,"version":"0.6.0","status":"running","port":7700,"daemon":{"version":"0.6.0","pid":812}}`. `starting` means Trackwall is still coming up; an error says what failed. After crashing ten times in a row within a minute of each start, Trackwall is not started again until you run the command. A Trackwall you started some other way in the container keeps running, but nothing starts it again after a crash; the log says so.

The Feature's `port` option changes the port, for example `{ "port": "7701" }` in place of `{}`; forward the same number. Releases up to 0.5.13 have no Feature; use a newer one.

## Bring your skills and plugins

Copilot CLI in the container sees only what is in the container: the skills and plugins on your computer are not there. Sessions start fine without them, so it is easy to miss.

- Plugins and skills in `~/.copilot` stay in the `workspace-copilot` volume. Install the plugins once in a terminal of the container, with `copilot plugin marketplace add` and `copilot plugin install` as on your computer.
- Skills you keep in `~/.agents/skills` or `~/.claude/skills` need volumes of their own, or a rebuild of the container loses them. Add them to `mounts`, and their folders to the `chown` of `postCreateCommand`:

  ```json
  "source=workspace-agents,target=/home/vscode/.agents,type=volume",
  "source=workspace-claude,target=/home/vscode/.claude,type=volume"
  ```

- Then install the skills inside the container (for example `npx skills add <source> -g`), or copy their folders in. A skill folder copied from Windows may have Windows line endings in its scripts; installing it again in the container avoids that.
- To check, run `/skills` in a session: it lists the skills Copilot CLI found. Skills a repo keeps in its own folders come with the repo and need nothing.

## Use the desktop app

The desktop app can use Trackwall in the container instead of running its own, so you keep the tray, system notifications when a session needs you, several windows, `trackwall://` links and [Start at sign-in](/features/start-at-sign-in).

1. Install the desktop app on your computer, the same version as Trackwall in the container (see [Install](/guide/install)).
2. Look up the address of Trackwall in the container with its token, as in step 3 above.
3. In the app, open Settings › App › Daemon in a container, paste the address and click "Connect". When the app's own Trackwall did not start, the same field is on the screen it shows instead.

Or let the app start the container and connect by itself, see [Start the container from the app](#start-the-container-from-the-app).

The app restarts, stops its own Trackwall with its sessions, and from then on connects to the one in the container. It neither starts nor stops that one: quitting the app leaves it running. Trackwall in the container gets a new token every time it starts, so within a few seconds after it restarts the app says the token was not accepted and shows the field again; paste the new address. The tray menu's "Quit" leaves it running too. "Use this app's own daemon" in the same place goes back.

In the app, links and "Open in VS Code" open on your computer as they do from the browser. "Show in Explorer" comes back once the app knows where your computer sees the repos: in Settings › App › Daemon in a container, set "Projects folder on this computer" to the volume's folder, for example `\\wsl.localhost\rancher-desktop\var\lib\docker\volumes\workspace-repos\_data` with Rancher Desktop. To find it, run `wsl -l -v` for the name of the distribution and `docker volume inspect workspace-repos` for the folder of the volume (`Mountpoint`), and check that Explorer opens it. Files you save there from Windows can end up owned by `root` inside the container, so git in the container may not be able to change them; browse there, and edit inside the container. This works on Windows and macOS. The folder picker and dropping files on the window are not there, since paths on your computer mean nothing inside the container. The app and Trackwall in the container must be the same version: after the app updates itself, update the container too (see the last points below).

### Start the container from the app

The app can do what you would otherwise do by hand: open the dev container, wait for Trackwall in it and connect with its current token. It also does that after Trackwall in the container restarted with a new token.

1. Set up the container with the Trackwall Feature and `TRACKWALL_HOME`, as in [Set up the container](#set-up-the-container): the Feature starts Trackwall with the container, and `TRACKWALL_HOME` tells the app where its state is.
2. Rebuild the container once ("Dev Containers: Rebuild Container" in VS Code).
3. In the app, open Settings › App › Daemon in a container. Under the dev container, enter the folder on your computer that holds `.devcontainer` (the folder you open in a container yourself) and the folder VS Code opens inside it, `/workspaces` in the example, and click "Save". While the app is connected to Trackwall in a container that sets `TRACKWALL_DEVCONTAINER_HOST_FOLDER`, the first field is already filled in.
4. Click "Start the dev container and connect".

Docker Desktop or Rancher Desktop has to be running. If the container already runs with Trackwall in it, the app connects right away, and starts Trackwall there first when it is not running; if Trackwall there is another version than the app, it says so at once and offers "Update Trackwall in the container", which installs the app's version there with `trackwall-container update` (see the last points below) and connects once it answers, after a few minutes. If the new version does not start, Trackwall in the container goes back to the one it had and the app says so. "Cancel" stops the app's wait, not the update in the container. Otherwise it opens VS Code on the dev container, as your own shortcut or "Reopen in Container" does; VS Code may ask once whether to open it. The first start builds the container and can take several minutes. Once Trackwall in the container answers on the forwarded port, the app restarts and connects. Keep the VS Code window open: it forwards the port. When Trackwall in the container restarts later, the app shows the same button again on the screen it shows when it cannot connect.

While it waits, **Cancel** stops the start, for example when VS Code shows an error in its own window; the app shows "Starting…" and Cancel also after the window reloads or in another window. If a container for the folder runs under the same path written with other upper- and lower-case letters (`c:\Users\...` instead of `C:\Users\...`, as the `devcontainer` command line may write it), VS Code does not reuse it and, when the configuration names the container in `runArgs`, cannot create its own: after a minute the app says so and names the `docker rm -f` command that removes it.

The app finds the container by the folder you entered and reads Trackwall's address and token from it with `docker`; nothing is sent anywhere else. A dev container opened from a folder inside WSL instead of Windows is not supported yet.

## MCP servers on your computer

Copilot CLI in the container reaches an MCP server that runs on your computer at `host.docker.internal` instead of `localhost`, for example `http://host.docker.internal:3000/mcp` in `~/.copilot/mcp-config.json` in the container. Keep `host.docker.internal` in `NO_PROXY`, or a proxy gets the request first. Docker Desktop provides that name; with Docker Engine on Linux, add `"runArgs": ["--add-host=host.docker.internal:host-gateway"]` to `devcontainer.json`.

Tokens for such servers come in through [Environment from mise](/features/mise-environment) like on your computer. Follow that page's steps in the container to create the age key: it lands in `~/.config/mise`, which the `workspace-mise` volume keeps across rebuilds.

## Back up the repos

Commits you have not pushed, stashes and task worktrees live only in the `workspace-repos` volume. Before you remove the volume, reset Docker, or move to another computer, copy the volume into one file on your computer. Run this on your computer, not in the container, in the folder where the file should go, while no task is running:

```sh
docker run --rm -v workspace-repos:/repos:ro -v "${PWD}:/backup" debian:stable-slim tar czf /backup/workspace-repos.tar.gz -C /repos .
```

It works the same in PowerShell, in a terminal of macOS and in WSL. The volume is mounted read-only, so the backup cannot change your repos. To put it back into a new, empty volume of the same name:

```sh
docker run --rm -v workspace-repos:/repos -v "${PWD}:/backup" debian:stable-slim tar xzf /backup/workspace-repos.tar.gz -C /repos
```

The same two commands, with another volume's name, back up Trackwall's state (`workspace-trackwall`) or the Copilot CLI sign-in (`workspace-copilot`). The file holds everything in your repos, including files git ignores, such as a local `.env`, so keep it where you would keep the repos themselves.

## Good to know

- In the browser alone there is no tray and no [Start at sign-in](/features/start-at-sign-in); for those, [use the desktop app](#use-the-desktop-app). The tab shows how many agents wait for you in its title and can show [notifications in the browser](/features/browser-notifications).
- Links open in a new tab of your browser; when the browser blocks the new tab, allow pop-ups for the page.
- "Open in VS Code" opens the repo, task worktree or file in VS Code on your computer, inside the running container through the Dev Containers extension: with the extensions and settings of your `devcontainer.json` when it sets `TRACKWALL_DEVCONTAINER_HOST_FOLDER` (see [Set up the container](#set-up-the-container)), attached to the container otherwise. It reuses the running container of that folder; if none is running, VS Code starts or builds it as when you open the folder yourself. The browser asks once whether to open VS Code. "Show in the file manager" is not there, since a folder of the container means nothing to your computer. With Podman instead of Docker, set `dev.containers.dockerPath` to `podman` in VS Code first.
- The command from [Connect Copilot CLI](/guide/connect-copilot-cli) is a path inside the container, so it works for a Copilot CLI in the container, not on your computer.
- To update without rebuilding, run `trackwall-container update <version>` in the container, for example `trackwall-container update 0.6.0`. It answers at once and does the rest in the background: it downloads that version from GitHub, checks that it was signed by Trackwall's release key, restarts Trackwall on it, and goes back to the version you had when the new one does not start within a minute. Running sessions stop and resume as after any restart. `logs/daemon.log` in Trackwall's state folder says how it went, and `trackwall-container address` gives the new address with its token. The update stays in the state volume; rebuilding the container returns to the version in the Feature's address unless you change `<version>` there too, which is the other way to update.
- VS Code's port forward starts a program for every new connection, which can take a few seconds when the computer is busy or its security software checks every program that starts. The desktop app waits up to 10 seconds for Trackwall in a container before it says it lost the connection. If it still loses it while Trackwall in the container runs (inside the container `curl http://127.0.0.1:7700/api/health` answers at once), the forward is slower than that: close other work or ask whoever runs the security software to exclude `docker.exe`.
- Repos with changes you have not pushed live only in the `workspace-repos` volume. Removing the volume, or "Reset to factory defaults" in Docker Desktop, deletes them. "Only in this container" on [Home](/features/home) and the [doctor](/features/doctor) list what is at stake. [Back up the repos](#back-up-the-repos) before you remove the volume.
