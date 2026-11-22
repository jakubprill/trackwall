import { win32 } from "node:path";

/**
 * Whether Git for Windows can start in Copilot CLI's sandbox (ADR-181). On Windows the sandbox runs a task's commands in
 * an AppContainer, which may run only programs that grant the group ALL APPLICATION PACKAGES read and execute. A default
 * install inherits that from Program Files; a Git whose files carry an ACL of their own without it fails every git
 * command with "Access denied", so a task in the sandbox cannot commit (found on a real Windows machine, #364). The
 * group is read by its SID, since Windows shows its name in the system's language.
 */

/** The SID of ALL APPLICATION PACKAGES. */
export const ALL_APPLICATION_PACKAGES = "S-1-15-2-1";

/**
 * Reads the ACL of the file in `TRACKWALL_ACL_PATH` as `SID|Allow or Deny|rights` lines; the path never enters the
 * script. .NET only, no cmdlet: a `PSModulePath` inherited from PowerShell 7 keeps Windows PowerShell from loading
 * `Get-Acl`'s module (the CI runner showed it), and the rules come with their SIDs, so nothing is translated.
 */
const ACL_SCRIPT =
  "$acl = [System.Security.AccessControl.FileSecurity]::new($env:TRACKWALL_ACL_PATH, 'Access'); foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { $rule.IdentityReference.Value + '|' + $rule.AccessControlType + '|' + $rule.FileSystemRights }";

/** PowerShell's `-EncodedCommand`: the script as UTF-16LE in base64, so no quoting on the command line can change it. */
const ENCODED_ACL_SCRIPT = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");

/** The rights that let a program start; a deny of any of them stops it. */
const RUN_RIGHTS = /ReadAndExecute|ExecuteFile|Modify|FullControl/;

/** Whether the ACL lines of `ACL_SCRIPT` let ALL APPLICATION PACKAGES start the program. */
export function appPackagesCanRun(acl: string): boolean {
  const entries = acl
    .split(/\r?\n/)
    .map((line) => line.trim().split("|"))
    .filter(([sid]) => sid === ALL_APPLICATION_PACKAGES);
  if (entries.some(([, type, rights]) => type === "Deny" && RUN_RIGHTS.test(rights ?? ""))) return false;
  return entries.some(([, type, rights]) => type === "Allow" && RUN_RIGHTS.test(rights ?? ""));
}

/** Git's install folder from the program the daemon runs: `…\Git` from `…\Git\mingw64\bin\git.exe` or `…\Git\cmd\git.exe`. */
export function gitInstallFolder(program: string): string {
  const match = program.match(/^(.*?)\\(?:mingw64\\bin|mingw32\\bin|cmd|bin)\\git\.exe$/i);
  return match?.[1] ?? win32.dirname(program);
}

export type RunAclScript = (command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

/**
 * Whether git at `program` cannot start in the sandbox: `true` when its ACL leaves ALL APPLICATION PACKAGES out, `false`
 * when it lets them run it, `null` when PowerShell could not read the ACL, which says nothing either way.
 */
export async function sandboxGitBlocked(
  program: string,
  run: RunAclScript,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean | null> {
  try {
    return !appPackagesCanRun(await readAcl(program, run, env, timeoutMs));
  } catch {
    return null;
  }
}

/** The ACL lines of `program`; throws with PowerShell's message when it cannot read them, or when it reads none. */
export async function readAcl(program: string, run: RunAclScript, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const acl = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_ACL_SCRIPT], {
    env: { ...env, TRACKWALL_ACL_PATH: program },
    timeoutMs,
  });
  if (acl.trim() === "") throw new Error(`PowerShell read no access rules of ${program}`);
  return acl;
}
