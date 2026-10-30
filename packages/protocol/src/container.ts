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
 * may hold spaces. No control characters, so the link built from it says only what the folder's name says.
 */
export const DevContainerFolder = z
  .string()
  .min(1)
  .max(4096)
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
