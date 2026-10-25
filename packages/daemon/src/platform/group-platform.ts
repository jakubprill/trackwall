import type { GroupPlatform } from "./process-group.ts";
import { runtimeInfo } from "./runtime.ts";

let platform: Promise<GroupPlatform> | undefined;

/** The implementation for the current system and runtime, loaded once; `bun:ffi` only under Bun on Windows. */
export function groupPlatform(): Promise<GroupPlatform> {
  platform ??=
    process.platform === "win32"
      ? import("./win32-group.ts").then((m) => m.win32Groups(runtimeInfo().name === "bun"))
      : import("./posix-group.ts").then((m) => m.posixGroups);
  return platform;
}
