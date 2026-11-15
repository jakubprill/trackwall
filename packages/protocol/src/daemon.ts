import { z } from "zod";
import { apiResult } from "./api.ts";
import { ContainerId, DevContainerFolder } from "./container.ts";

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

export const HEALTH_PATH = "/api/health";

/** `GET /api/health`: public, without the token, only as much as discovering the daemon needs. */
export const Health = z.object({
  status: z.literal("ok"),
  version: z.string(),
  /**
   * A random id of this start of the daemon, public like the rest: a page in a browser keeps its token together with it
   * and sends the token only to the same start, never to whatever listens on the address later (ADR-161). Optional, so that
   * a newer daemon or bridge still recognises an older running daemon, which has none, and asks for its restart.
   */
  instance: z.string().optional(),
});
export type Health = z.infer<typeof Health>;
export const HealthResult = apiResult(Health);

/**
 * `POST /api/page-code`, with the daemon token: a one-time code for a page address (`#code=`), which `trackwall-daemon
 * address` prints and `--ui` opens instead of the token, so that the browser's history holds nothing that lasts (ADR-161).
 */
export const PAGE_CODE_PATH = "/api/page-code";
export const PageCode = z.object({ code: z.string(), expiresInMs: z.number().int().positive() });
export type PageCode = z.infer<typeof PageCode>;
export const PageCodeResult = apiResult(PageCode);

/** `POST /api/page-code/exchange`, with a page code as the bearer instead of the token: answers the token, once per code. */
export const PAGE_CODE_EXCHANGE_PATH = "/api/page-code/exchange";
export const PageCodeExchange = z.object({ token: z.string() });
export type PageCodeExchange = z.infer<typeof PageCodeExchange>;
export const PageCodeExchangeResult = apiResult(PageCodeExchange);

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
  /**
   * The folder on the user's computer the dev container was opened from, when the dev container hands it over
   * (`TRACKWALL_DEVCONTAINER_HOST_FOLDER`, ADR-121): VS Code links then open through its `devcontainer.json`. `null`
   * otherwise.
   */
  devContainerFolder: DevContainerFolder.nullable(),
  /**
   * The port of the service proxy on `127.0.0.1` (ADR-189), which opens a running service at
   * `http://<repo>.localhost:<port>/`; `null` when the daemon runs none (outside a dev container by default).
   */
  serviceProxyPort: z.number().int().min(1).max(65535).nullable(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;
export const DaemonInfoResult = apiResult(DaemonInfo);

/** `POST /api/daemon/shutdown`: graceful exit (quit from the tray). */
export const ShutdownResult = apiResult(z.object({ stopping: z.literal(true) }));
