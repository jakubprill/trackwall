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
- A Linux image with git, curl and unzip. Debian or Ubuntu is the simplest. On Alpine, Bun also needs `libstdc++` and `libgcc` (`apk add libstdc++ libgcc`).

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
  "forwardPorts": [7700],
  "portsAttributes": {
    "7700": { "label": "Trackwall", "requireLocalPort": true, "onAutoForward": "silent" }
  },
  "containerEnv": { "NO_PROXY": "127.0.0.1,localhost,host.docker.internal" },
  "postCreateCommand": "sudo chown -R vscode:vscode /workspaces /home/vscode/.trackwall /home/vscode/.copilot /home/vscode/.config/mise"
}
```

- A new volume belongs to `root`, so `postCreateCommand` hands the folders to the container's user.
- `requireLocalPort` keeps the forwarded port at 7700 on your computer. Trackwall accepts a page only from `127.0.0.1:<port>` or `localhost:<port>` with the port it listens on, so a forward to another number does not load.
- Behind a proxy, set `HTTPS_PROXY` and `HTTP_PROXY` in `containerEnv` too, and keep `NO_PROXY` as above. A proxy that replaces certificates also needs its certificate in the image.

## Start Trackwall

Trackwall has no Linux download, so it runs from its source. In a terminal of the container:

1. Install mise and turn it on in your shell: `curl https://mise.run | sh && echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc`, then open a new terminal.
2. Install the tools Trackwall needs and Copilot CLI: `mise use -g node@22 bun@1.4.4 pnpm@10.28.0 && npm install -g @github/copilot`.
3. Clone Trackwall outside the projects folder and build its page: `git clone https://github.com/jakubprill/trackwall.git ~/trackwall && cd ~/trackwall && pnpm install --frozen-lockfile && pnpm --filter @trackwall/ui build`.
4. Point Trackwall at the repos: `echo "projectsDir: /workspaces" > ~/.trackwall/workspace.yaml`.
5. Start it on the forwarded port: `bun packages/daemon/src/main.ts --port 7700`.
6. In a second terminal, print the address with its token: `echo "http://127.0.0.1:7700/#token=$(sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' ~/.trackwall/daemon.json)"`, and open it in the browser on your computer.
7. Sign in to Copilot CLI once: run `copilot`, type `/login` and follow the steps in your browser. The sign-in stays in the `workspace-copilot` volume.

The token changes every time Trackwall starts, so look the address up again after a restart. Trackwall stops when its terminal or the container stops.

## Use the desktop app

The desktop app can use Trackwall in the container instead of running its own, so you keep the tray, system notifications when a session needs you, several windows, `trackwall://` links and [Start at sign-in](/features/start-at-sign-in).

1. Install the desktop app on your computer, the same version as Trackwall in the container (see [Install](/guide/install)).
2. Start Trackwall in the container and look up its address with the token, as in steps 5 and 6 above.
3. In the app, open Settings › App › Daemon in a container, paste the address and click "Connect". When the app's own Trackwall did not start, the same field is on the screen it shows instead.

The app restarts, stops its own Trackwall with its sessions, and from then on connects to the one in the container. It neither starts nor stops that one: quitting the app leaves it running. Trackwall in the container gets a new token every time it starts, so after it restarts the app says the token was not accepted and shows the field again (click "Try again" when a view reports the error first); paste the new address. "Use this app's own daemon" in the same place goes back.

In the app, links and "Open in VS Code" open on your computer as they do from the browser. "Show in Explorer" comes back once the app knows where your computer sees the repos: in Settings › App › Daemon in a container, set "Projects folder on this computer" to the volume's folder, for example `\\wsl.localhost\rancher-desktop\var\lib\docker\volumes\workspace-repos\_data` with Rancher Desktop. To find it, run `wsl -l -v` for the name of the distribution and `docker volume inspect workspace-repos` for the folder of the volume (`Mountpoint`), and check that Explorer opens it. Files you save there from Windows can end up owned by `root` inside the container, so git in the container may not be able to change them; browse there, and edit inside the container. This works on Windows and macOS. The folder picker and dropping files on the window are not there, since paths on your computer mean nothing inside the container. The app and Trackwall in the container must be the same version: after the app updates itself, update the container too (see the last points below).

## MCP servers on your computer

Copilot CLI in the container reaches an MCP server that runs on your computer at `host.docker.internal` instead of `localhost`, for example `http://host.docker.internal:3000/mcp` in `~/.copilot/mcp-config.json` in the container. Keep `host.docker.internal` in `NO_PROXY`, or a proxy gets the request first. Docker Desktop provides that name; with Docker Engine on Linux, add `"runArgs": ["--add-host=host.docker.internal:host-gateway"]` to `devcontainer.json`.

Tokens for such servers come in through [Environment from mise](/features/mise-environment) like on your computer. Follow that page's steps in the container to create the age key: it lands in `~/.config/mise`, which the `workspace-mise` volume keeps across rebuilds.

## Good to know

- In the browser alone there is no tray, no system notifications and no [Start at sign-in](/features/start-at-sign-in); for those, [use the desktop app](#use-the-desktop-app).
- Links open in a new tab of your browser; when the browser blocks the new tab, allow pop-ups for the page.
- "Open in VS Code" opens the repo, task worktree or file in VS Code on your computer, attached to the running container through the Dev Containers extension. The browser asks once whether to open VS Code. "Show in the file manager" is not there, since a folder of the container means nothing to your computer. With Podman instead of Docker, set `dev.containers.dockerPath` to `podman` in VS Code first.
- The command from [Connect Copilot CLI](/guide/connect-copilot-cli) is a path inside the container, so it works for a Copilot CLI in the container, not on your computer.
- Packages installed on Alpine do not work on Debian and the other way round. After switching the image, delete `node_modules` in `~/trackwall` and run the install and build of step 3 again.
- To update, run `git pull` in `~/trackwall`, then the install and build of step 3, and start Trackwall again.
- Repos with changes you have not pushed live only in the `workspace-repos` volume. Removing the volume, or "Reset to factory defaults" in Docker Desktop, deletes them.
