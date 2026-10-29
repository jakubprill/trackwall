import { z } from "zod";
import { apiResult } from "./api.ts";
import { ContainerId } from "./container.ts";

/** The name of the daemon's header and discovery file; one place for the daemon, UI, Tauri and CLI. */
export const DAEMON_FILE = "daemon.json";
export const TRACKWALL_HOME_ENV = "TRACKWALL_HOME";

/** `~/.trackwall/daemon.json`, written by the daemon at startup (§5.1). */
export const DaemonFile = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  startedAt: z.string(),
  version: z.string(),
});
export type DaemonFile = z.infer<typeof DaemonFile>;

/** `GET /api/health`: public, without the token, only as much as discovering the daemon needs. */
export const Health = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type Health = z.infer<typeof Health>;
export const HealthResult = apiResult(Health);

export const DAEMON_INFO_PATH = "/api/daemon/info";

/** `GET /api/daemon/info`: details of the daemon process, needs the token. */
export const DaemonInfo = z.object({
  version: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  uptimeMs: z.number().nonnegative(),
  platform: z.string(),
  arch: z.string(),
  runtime: z.object({ name: z.enum(["bun", "node"]), version: z.string() }),
  launchedBy: z.enum(["desktop", "manual"]),
  home: z.string(),
  /**
   * The program and arguments of the stdio bridge to this daemon's MCP server (`trackwall-daemon mcp-stdio`, §5.3), ready
   * for an agent CLI's MCP config: the full path of the binary, and when run from source, the runtime and the script.
   */
  mcpStdioCommand: z.array(z.string()).min(1),
  /**
   * Whether the daemon opens links, folders and VS Code on the user's desktop (ADR-120). `false` in a container or on a
   * Linux system without a graphical session: the page opens web links itself, and opening a folder or VS Code is
   * refused with `no_desktop`.
   */
  desktop: z.boolean(),
  /** The container the daemon runs in, for VS Code links into it (ADR-121); `null` outside one or when it cannot tell. */
  container: ContainerId.nullable(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;
export const DaemonInfoResult = apiResult(DaemonInfo);

/** `POST /api/daemon/shutdown`: graceful exit (quit from the tray). */
export const ShutdownResult = apiResult(z.object({ stopping: z.literal(true) }));
