import type { GroupPlatform } from "./process-group.ts";
import { runtimeInfo } from "./runtime.ts";

let platform: Promise<GroupPlatform> | undefined;

/** Implementacja dla bieżącego systemu i runtime'u, ładowana raz; `bun:ffi` tylko pod Bun na Windowsie. */
export function groupPlatform(): Promise<GroupPlatform> {
  platform ??=
    process.platform === "win32"
      ? import("./win32-group.ts").then((m) => m.win32Groups(runtimeInfo().name === "bun"))
      : import("./posix-group.ts").then((m) => m.posixGroups);
  return platform;
}
