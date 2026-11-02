import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxProblem, sandboxState, taskSandbox } from "../src/modules/agents/copilot-sandbox.ts";
import { sandboxProgramsFolder } from "./support/sandbox-programs.ts";

const EMPTY_PATH = { PATH: mkdtempSync(join(tmpdir(), "trackwall-empty-path-")) };

// Looking a program up in `PATH` follows the system the test runs on (`PATHEXT` on Windows), so the Linux answers are
// checked on Linux and the macOS one on macOS, each in its CI run.
const onLinux = process.platform === "linux";

describe("whether Copilot CLI's sandbox can run on this computer (ADR-181)", () => {
  test.if(onLinux)("on Linux it needs bubblewrap and the network programs in the sessions' PATH", () => {
    expect(sandboxProblem({ PATH: sandboxProgramsFolder() }, "linux", [])).toBeNull();
    expect(sandboxProblem(EMPTY_PATH, "linux", [])).toBe(
      "bubblewrap (bwrap), slirp4netns, ip (iproute2), iptables, which Copilot CLI's sandbox runs on, are not in PATH",
    );
  });

  test.if(onLinux)("on Linux ip and iptables also count in the system folders a user's PATH may leave out", () => {
    const programs = sandboxProgramsFolder();
    const systemOnly = mkdtempSync(join(tmpdir(), "trackwall-path-"));
    for (const program of ["bwrap", "slirp4netns"]) {
      writeFileSync(join(systemOnly, program), "#!/bin/sh\n");
      chmodSync(join(systemOnly, program), 0o755);
    }
    expect(sandboxProblem({ PATH: systemOnly }, "linux", [programs])).toBeNull();
    expect(sandboxProblem({ PATH: systemOnly }, "linux", [])).toBe(
      "ip (iproute2), iptables, which Copilot CLI's sandbox runs on, are not in PATH",
    );
  });

  test.if(process.platform === "darwin")("on macOS it runs on the system's sandbox-exec", () => {
    expect(sandboxProblem(EMPTY_PATH, "darwin")).toBeNull();
  });

  test("on Windows only Copilot CLI can tell, by the system's version, so the daemon lets it decide", () => {
    expect(sandboxProblem(EMPTY_PATH, "win32")).toBeNull();
  });

  test("on another system it cannot run at all", () => {
    expect(sandboxProblem(EMPTY_PATH, "freebsd")).toBe("Copilot CLI's sandbox does not run on freebsd");
  });

  test("with sandbox.tasks off nothing is checked, since no task runs in it", () => {
    expect(sandboxState({ tasks: "off" }, EMPTY_PATH)).toEqual({ tasks: "off", problem: null });
  });
});

describe("whether a new task runs in Copilot CLI's sandbox (ADR-181)", () => {
  const missing = "bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH";

  test("auto puts in it only the tasks without approvals, all every task, off none", () => {
    expect(taskSandbox({ tasks: "auto", problem: null }, "auto")).toBe(true);
    expect(taskSandbox({ tasks: "auto", problem: null }, "ask")).toBe(false);
    expect(taskSandbox({ tasks: "all", problem: null }, "ask")).toBe(true);
    expect(taskSandbox({ tasks: "off", problem: null }, "auto")).toBe(false);
  });

  test("a task that should run in it is refused where it cannot run, saying why and how to get out of it", () => {
    expect(() => taskSandbox({ tasks: "auto", problem: missing }, "auto")).toThrow(
      expect.objectContaining({
        code: "bad_request",
        message:
          "this task should run in Copilot CLI's sandbox (sandbox.tasks: auto in workspace.yaml), but bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH; install it, or set sandbox.tasks to off",
      }),
    );
  });

  test("a task outside it starts also where the sandbox cannot run", () => {
    expect(taskSandbox({ tasks: "auto", problem: missing }, "ask")).toBe(false);
  });
});
