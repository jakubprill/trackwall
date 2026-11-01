import { z } from "zod";

/**
 * A daemon in a Docker or Podman container (ADR-121): the container's full id, which VS Code's Dev Containers extension
 * takes to open a folder inside it from the user's computer.
 */
export const ContainerId = z.string().regex(/^[0-9a-f]{64}$/);
export type ContainerId = z.infer<typeof ContainerId>;

/**
 * The folder on the user's computer that holds the dev container's `.devcontainer/` (ADR-121), as the dev container hands
 * it over in `TRACKWALL_DEVCONTAINER_HOST_FOLDER` (`${localWorkspaceFolder}`): a Windows path keeps its backslashes and
 * may hold spaces. No control characters, and short enough that the link built from it stays below the 2083 characters
 * a Windows URL handler takes, even for a folder of non-ASCII names, which double in hex.
 */
export const DevContainerFolder = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => [...p].every((c) => c >= " "), "dev container folder: no control characters");
export type DevContainerFolder = z.infer<typeof DevContainerFolder>;

/**
 * The address that opens a folder or file of the container in VS Code on the user's computer, attached to the running
 * container: `vscode://vscode-remote/attached-container+<the container id in hex>/<path>`. The page opens it, since the
 * daemon in the container has no desktop (ADR-120). It works for any running container, but without the extensions and
 * settings of a `devcontainer.json`.
 */
export function containerEditorUrl(container: ContainerId, path: string): string {
  return `vscode://vscode-remote/attached-container+${hex(container)}/${linuxPath(path)}`;
}

/**
 * The same, opened through the dev container's configuration: `vscode://vscode-remote/dev-container+<the folder in
 * hex>/<path>`, the address a dev container's own shortcut opens. VS Code reuses the running container of that folder and
 * opens the path with the extensions and settings of its `devcontainer.json`, in the window the user works in every day.
 */
export function devContainerEditorUrl(folder: DevContainerFolder, path: string): string {
  return `vscode://vscode-remote/dev-container+${hex(folder)}/${linuxPath(path)}`;
}

/** The hex of the UTF-8 bytes, the form the Dev Containers extension reads after `+`. */
function hex(text: string): string {
  return [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The path is a Linux path, so unlike `vscodeUrl` in the daemon, which keeps a Windows drive letter's colon, every
 * segment is encoded whole.
 */
function linuxPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
}

/**
 * What `trackwall-container start` prints (ADR-164): one JSON object on stdout, for a person in a terminal of the dev
 * container and for the desktop app once it runs it through `docker exec` (ADR-139). `version` is the installed
 * Trackwall's; `daemon` is the one that answers on the state directory, which after an update can be another version.
 * `starting` means the daemon did not answer within the wait: the caller polls `/api/health` on `port`. The error codes
 * are stable, so the app can tell what to show without reading the message.
 */
const CONTAINER_START_ERRORS = ["bad-arguments", "start-failed"] as const;
const Port = z.number().int().min(1).max(65535);
export const ContainerStartResult = z.union([
  z.object({
    ok: z.literal(true),
    version: z.string(),
    status: z.literal("running"),
    port: Port,
    daemon: z.object({ version: z.string(), pid: z.number().int() }),
  }),
  z.object({ ok: z.literal(true), version: z.string(), status: z.literal("starting"), port: Port }),
  z.object({
    ok: z.literal(false),
    version: z.string(),
    error: z.object({ code: z.enum(CONTAINER_START_ERRORS), message: z.string() }),
  }),
]);
export type ContainerStartResult = z.infer<typeof ContainerStartResult>;

/**
 * What `trackwall-container update <version>` prints (ADR-165), in the same way: `updating` means the background process
 * has started (the caller polls `/api/health` until the daemon reports `target`, and `logs/daemon.log` tells the rest),
 * `current` that the daemon already runs `target`.
 */
const CONTAINER_UPDATE_ERRORS = ["bad-arguments", "update-running", "update-failed"] as const;
export const ContainerUpdateResult = z.union([
  z.object({ ok: z.literal(true), version: z.string(), status: z.enum(["updating", "current"]), target: z.string() }),
  z.object({
    ok: z.literal(false),
    version: z.string(),
    error: z.object({ code: z.enum(CONTAINER_UPDATE_ERRORS), message: z.string() }),
  }),
]);
export type ContainerUpdateResult = z.infer<typeof ContainerUpdateResult>;
