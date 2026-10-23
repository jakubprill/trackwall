import { z } from "zod";
import { apiResult } from "./api.ts";

/** Nazwa nagłówka i pliku odkrywania daemona; jedno miejsce dla daemona, UI, Tauri i CLI. */
export const DAEMON_FILE = "daemon.json";
export const PITWALL_HOME_ENV = "PITWALL_HOME";

/** `~/.pitwall/daemon.json`, zapisywany przez daemon przy starcie (§5.1). */
export const DaemonFile = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  startedAt: z.string(),
  version: z.string(),
});
export type DaemonFile = z.infer<typeof DaemonFile>;

/** `GET /api/health`: publiczne, bez tokenu, tylko tyle, ile trzeba do odkrycia daemona. */
export const Health = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type Health = z.infer<typeof Health>;
export const HealthResult = apiResult(Health);

/** `GET /api/daemon/info`: szczegóły procesu daemona, wymaga tokenu. */
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
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;
export const DaemonInfoResult = apiResult(DaemonInfo);

/** `POST /api/daemon/shutdown`: łagodne zakończenie (wyjście z traya). */
export const ShutdownResult = apiResult(z.object({ stopping: z.literal(true) }));
