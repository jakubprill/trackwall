import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ContainerStartResult } from "@trackwall/protocol";
import { CONTAINER_COMMAND, runningSupervisor, SUPERVISE_COMMAND } from "./container-supervisor.ts";
import { isAlive, probeRunningDaemon } from "./discovery.ts";
import { selfCommand } from "./self-command.ts";

/**
 * `trackwall-container start` (ADR-164): makes sure a daemon runs in the dev container and says how it stands, as one JSON
 * object. Safe to run any number of times: from the dev container's `postStartCommand`, from the desktop app through
 * `docker exec`, by hand. A daemon that answers is left as it is, whatever its version; a supervisor already starting one
 * is waited for; otherwise a new supervisor starts in the background and outlives this command.
 */

/** The command answers well inside the 20 s the desktop app gives a `docker exec` (ADR-139). */
const WAIT_FOR_DAEMON_MS = 10_000;
const POLL_MS = 200;

export interface ContainerStartOptions {
  home: string;
  port: number;
  version: string;
  waitMs?: number;
}

export async function containerStart(o: ContainerStartOptions): Promise<ContainerStartResult> {
  const running = await probeRunningDaemon(o.home);
  if (running) return answering(o, running);
  const existing = runningSupervisor(o.home);
  let supervising: () => boolean;
  if (existing !== undefined) supervising = () => isAlive(existing);
  else {
    try {
      supervising = await startSupervisor(o.home, o.port);
    } catch (err) {
      return failed(o, `could not start the supervisor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const deadline = Date.now() + (o.waitMs ?? WAIT_FOR_DAEMON_MS);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const daemon = await probeRunningDaemon(o.home);
    if (daemon) return answering(o, daemon);
    if (!supervising()) {
      return failed(o, `the daemon did not start; see ${o.home}/logs/daemon.log in the container`);
    }
  }
  return { ok: true, version: o.version, status: "starting", port: o.port, daemon: null };
}

function answering(o: ContainerStartOptions, running: NonNullable<Awaited<ReturnType<typeof probeRunningDaemon>>>): ContainerStartResult {
  return {
    ok: true,
    version: o.version,
    status: "running",
    port: running.file.port,
    daemon: { version: running.version, pid: running.file.pid },
  };
}

function failed(o: ContainerStartOptions, message: string): ContainerStartResult {
  return { ok: false, version: o.version, error: { code: "start-failed", message } };
}

/**
 * Starts the supervisor in a session of its own, so it outlives `docker exec` and the shell of `postStartCommand`, and
 * resolves with whether it still runs. A supervisor that finds another one already holding the state directory ends at
 * once, and the wait then goes on for the daemon of the other.
 */
function startSupervisor(home: string, port: number): Promise<() => boolean> {
  const { exec, args } = selfCommand([CONTAINER_COMMAND, SUPERVISE_COMMAND, "--port", String(port), "--home", home]);
  return new Promise((resolve, reject) => {
    const child = spawn(exec, args, { cwd: homedir(), detached: true, stdio: "ignore" });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(() => !exited || runningSupervisor(home) !== undefined);
    });
  });
}
