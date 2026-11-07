import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultSandboxTasks,
  NAMESPACE_PROBE_ARGS,
  namespacesProblem,
  type SandboxHost,
  sandboxProblem,
  sandboxState,
  taskSandbox,
} from "../src/modules/agents/copilot-sandbox.ts";
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
});

/** A `bwrap` that prints its arguments into `args.txt` next to it and ends with `exitCode`, printing `stderr`. */
function fakeBwrap(exitCode: number, stderr = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-bwrap-"));
  const bwrap = join(dir, "bwrap");
  writeFileSync(bwrap, `#!/bin/sh\necho "$@" > "${join(dir, "args.txt")}"\nprintf '%s' '${stderr}' >&2\nexit ${exitCode}\n`);
  chmodSync(bwrap, 0o755);
  return bwrap;
}

describe("whether bubblewrap can make the sandbox's namespaces here (ADR-219, a real child process)", () => {
  test.if(onLinux)("a bubblewrap that runs a command in every namespace with its own /proc can", async () => {
    const bwrap = fakeBwrap(0);
    expect(await namespacesProblem(bwrap, process.env)).toBeNull();
    expect(readFileSync(join(dirname(bwrap), "args.txt"), "utf8").trim()).toBe(NAMESPACE_PROBE_ARGS.join(" "));
  });

  test.if(onLinux)("one refused by Docker's default seccomp profile cannot, with the last line bubblewrap printed", async () => {
    const bwrap = fakeBwrap(
      1,
      "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.",
    );
    expect(await namespacesProblem(bwrap, process.env)).toBe(
      "bubblewrap cannot make the sandbox's namespaces here (bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.)",
    );
  });
});

describe("which tasks run in the sandbox, with and without the key (ADR-181, ADR-219)", () => {
  test("without the key: on Linux the tasks without approvals, in a Linux container only where the sandbox can run, elsewhere none", () => {
    expect(defaultSandboxTasks(false, "linux", false)).toBe("auto");
    expect(defaultSandboxTasks(true, "linux", true)).toBe("auto");
    expect(defaultSandboxTasks(true, "linux", false)).toBe("off");
    expect(defaultSandboxTasks(false, "darwin", true)).toBe("off");
    expect(defaultSandboxTasks(false, "win32", true)).toBe("off");
  });

  const host = (inContainer: boolean, namespaces: string | null): SandboxHost & { probed: string[] } => {
    const probed: string[] = [];
    return {
      inContainer,
      platform: "linux",
      systemFolders: [],
      probed,
      namespaces: async (bwrap) => {
        probed.push(bwrap);
        return namespaces;
      },
    };
  };
  const refused = "bubblewrap cannot make the sandbox's namespaces here (bwrap: No permissions to create new namespace)";

  test.if(onLinux)("in a container whose bubblewrap can make its namespaces, tasks without approvals go into the sandbox", async () => {
    const env = { PATH: sandboxProgramsFolder() };
    const here = host(true, null);
    expect(await sandboxState(null, env, here)).toEqual({ tasks: "auto", problem: null, chosen: false });
    expect(here.probed).toEqual([join(env.PATH, "bwrap")]);
  });

  test.if(onLinux)("in a container that refuses them, no task does, and the reason stays for the doctor", async () => {
    const env = { PATH: sandboxProgramsFolder() };
    expect(await sandboxState(null, env, host(true, refused))).toEqual({ tasks: "off", problem: refused, chosen: false });
  });

  test.if(onLinux)(
    "on a Linux computer that refuses them, tasks without approvals still should, so they are refused rather than run outside it",
    async () => {
      const env = { PATH: sandboxProgramsFolder() };
      const state = await sandboxState(null, env, host(false, refused));
      expect(state).toEqual({ tasks: "auto", problem: refused, chosen: false });
      expect(() => taskSandbox(state, "auto")).toThrow(expect.objectContaining({ code: "bad_request" }));
    },
  );

  test.if(onLinux)("the key wins, and without bubblewrap's programs nothing is probed", async () => {
    const here = host(true, null);
    expect(await sandboxState({ tasks: "all" }, EMPTY_PATH, here)).toEqual({
      tasks: "all",
      problem: "bubblewrap (bwrap), slirp4netns, ip (iproute2), iptables, which Copilot CLI's sandbox runs on, are not in PATH",
      chosen: true,
    });
    expect(here.probed).toEqual([]);
  });
});

describe("whether a new task runs in Copilot CLI's sandbox (ADR-181)", () => {
  const missing = "bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH";

  test("auto puts in it only the tasks without approvals, all every task, off none", () => {
    expect(taskSandbox({ tasks: "auto", problem: null, chosen: true }, "auto")).toBe(true);
    expect(taskSandbox({ tasks: "auto", problem: null, chosen: true }, "ask")).toBe(false);
    expect(taskSandbox({ tasks: "all", problem: null, chosen: true }, "ask")).toBe(true);
    expect(taskSandbox({ tasks: "off", problem: null, chosen: true }, "auto")).toBe(false);
  });

  test("a task that should run in it is refused where it cannot run, saying why and how to get out of it", () => {
    expect(() => taskSandbox({ tasks: "auto", problem: missing, chosen: true }, "auto")).toThrow(
      expect.objectContaining({
        code: "bad_request",
        message:
          "this task should run in Copilot CLI's sandbox (sandbox.tasks: auto in workspace.yaml), but bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH; install it, or set sandbox.tasks to off",
      }),
    );
  });

  test("a task outside it starts also where the sandbox cannot run", () => {
    expect(taskSandbox({ tasks: "auto", problem: missing, chosen: true }, "ask")).toBe(false);
  });
});
