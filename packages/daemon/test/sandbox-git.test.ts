import { describe, expect, test } from "bun:test";
import { runProgram } from "../src/infra/run-program.ts";
import { findOnPath } from "../src/modules/agents/copilot-command.ts";
import { appPackagesCanRun, gitInstallFolder, readAcl, sandboxGitBlocked } from "../src/modules/doctor/sandbox-git.ts";

describe("whether Copilot CLI's sandbox on Windows can start git (#364)", () => {
  test("ALL APPLICATION PACKAGES with read and execute can run it, also when Windows shows the group in another language", () => {
    expect(appPackagesCanRun("S-1-5-18|Allow|FullControl\r\nS-1-15-2-1|Allow|ReadAndExecute, Synchronize\r\n")).toBe(true);
  });

  test("an ACL without the group, or with only read, does not let the sandbox run it", () => {
    expect(appPackagesCanRun("S-1-5-32-544|Allow|FullControl\r\nS-1-1-0|Allow|ReadAndExecute, Synchronize")).toBe(false);
    expect(appPackagesCanRun("S-1-15-2-1|Allow|Read, Synchronize")).toBe(false);
  });

  test("a deny of execute for the group wins over an allow", () => {
    expect(appPackagesCanRun("S-1-15-2-1|Deny|ExecuteFile\nS-1-15-2-1|Allow|ReadAndExecute, Synchronize")).toBe(false);
  });

  test("Git's install folder is above mingw64\\bin or cmd, whatever the drive and folder", () => {
    expect(gitInstallFolder("C:\\Program Files\\Git\\mingw64\\bin\\git.exe")).toBe("C:\\Program Files\\Git");
    expect(gitInstallFolder("D:\\Tools\\Git\\cmd\\git.exe")).toBe("D:\\Tools\\Git");
    expect(gitInstallFolder("D:\\portable\\git.exe")).toBe("D:\\portable");
  });

  test("an ACL PowerShell could not read says nothing either way", async () => {
    const failing = async () => {
      throw new Error("powershell.exe not found");
    };
    expect(await sandboxGitBlocked("C:\\Git\\cmd\\git.exe", failing, {}, 1000)).toBeNull();
    expect(await sandboxGitBlocked("C:\\Git\\cmd\\git.exe", async () => "\r\n", {}, 1000)).toBeNull();
  });

  test.skipIf(process.platform !== "win32")(
    "on a Windows with a default Git for Windows install, the real ACL lets the sandbox run git",
    async () => {
      const git = findOnPath("git", process.env);
      if (git === undefined) throw new Error("git is not on PATH");
      const run = async (command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) =>
        (await runProgram(command, args, { label: command, env: o.env, timeoutMs: o.timeoutMs })).stdout.toString("utf8");
      const acl = await readAcl(git, run, process.env, 60_000);
      expect({ acl, canRun: appPackagesCanRun(acl) }).toEqual({ acl, canRun: true });
    },
    70_000,
  );
});
