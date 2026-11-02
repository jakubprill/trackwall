import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_SANDBOX_PROGRAMS } from "../../src/modules/agents/copilot-sandbox.ts";

/**
 * A folder with an executable of every program Copilot CLI's sandbox runs on Linux (ADR-181), so that on a runner
 * without them the daemon sees that the sandbox can run. Put it in front of `PATH`.
 */
export function sandboxProgramsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-sandbox-programs-"));
  for (const { program } of LINUX_SANDBOX_PROGRAMS) {
    writeFileSync(join(dir, program), "#!/bin/sh\n");
    chmodSync(join(dir, program), 0o755);
  }
  return dir;
}
