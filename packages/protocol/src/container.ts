import { z } from "zod";

/**
 * A daemon in a Docker or Podman container (ADR-121): the container's full id, which VS Code's Dev Containers extension
 * takes to open a folder inside it from the user's computer.
 */
export const ContainerId = z.string().regex(/^[0-9a-f]{64}$/);
export type ContainerId = z.infer<typeof ContainerId>;

/**
 * The address that opens a folder or file of the container in VS Code on the user's computer, attached to the running
 * container: `vscode://vscode-remote/attached-container+<the container id in hex>/<path>`. The page opens it, since the
 * daemon in the container has no desktop (ADR-120).
 */
export function containerEditorUrl(container: ContainerId, path: string): string {
  const hex = [...new TextEncoder().encode(container)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoded = path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
  return `vscode://vscode-remote/attached-container+${hex}/${encoded}`;
}
