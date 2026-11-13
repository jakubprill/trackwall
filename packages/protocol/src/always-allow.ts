/**
 * Which tool permission patterns "Always allow" may remember for a repo's tasks (ADR-249). Copilot CLI runs an allowed
 * shell command without asking wherever its paths point, outside the worktree included (its contract test), so only a
 * narrow pattern may be remembered: a named shell command or one MCP tool, never a whole kind (`shell`, `write`), a
 * wildcard, or a command that writes, moves or deletes files by path, reaches the network, runs code given on its
 * command line, raises privileges, or pushes and configures git. The daemon checks the pattern Copilot CLI offers in its
 * dialog with this, and the `alwaysAllow` key of `workspace.yaml` is read through it too, so a hand edit cannot widen it.
 */

/** Copilot CLI's own tool kinds that take no narrower argument than a path or a URL, so none is remembered for good. */
const BUILT_IN_KINDS = new Set(["shell", "write", "read", "url", "memory"]);

/** Commands whose first word alone is enough to refuse: each can reach past the narrow scope a user expects. */
const NEVER_COMMANDS = new Set([
  // Shells, interpreters and wrappers that run code or another command given as an argument.
  ...["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd", "wsl"],
  ...["node", "nodejs", "bun", "deno", "python", "python2", "python3", "py", "perl", "ruby", "php", "lua", "osascript", "jshell"],
  ...["env", "xargs", "exec", "eval", "source", ".", "nohup", "timeout", "watch", "time", "nice", "find", "parallel"],
  ...["start", "start-process", "invoke-expression", "iex", "invoke-command", "icm", "call"],
  // Programs that download and run a package.
  ...["npx", "pnpx", "bunx", "uvx", "pipx"],
  // Raising privileges.
  ...["sudo", "su", "doas", "runas", "gsudo"],
  // Writing, moving or removing files by path, the repo's `.git` included.
  ...["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "mv", "move", "move-item", "mi", "cp", "copy", "copy-item"],
  ...["cpi", "xcopy", "robocopy", "tee", "set-content", "sc", "out-file", "add-content", "ac", "ln", "mklink", "new-item", "ni"],
  ...["chmod", "chown", "chgrp", "icacls", "attrib", "takeown", "dd", "truncate", "install", "sed", "awk", "gawk", "patch"],
  ...["tar", "unzip", "7z", "zip", "rsync", "shred"],
  // The network.
  ...["curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet", "socat"],
  ...["invoke-webrequest", "iwr", "invoke-restmethod", "irm"],
  // The system, containers and accounts outside the repo.
  ...["docker", "podman", "kubectl", "helm", "systemctl", "service", "launchctl", "schtasks", "crontab", "at", "reg"],
  ...["regedit", "setx", "gh", "glab", "az", "aws", "gcloud", "terraform"],
]);

/** Subcommands refused for a command allowed otherwise: pushing and configuring git, installing or running packages. */
const NEVER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["push", "config", "remote", "credential", "submodule", "clone", "-c"]),
  npm: new Set(["install", "i", "add", "exec", "x"]),
  pnpm: new Set(["add", "install", "i", "dlx", "exec"]),
  yarn: new Set(["add", "dlx", "exec"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  mise: new Set(["exec", "x", "install", "use"]),
};

/** Characters a shell would read as more than one plain command: Copilot CLI's labels never hold them. */
const SHELL_SYNTAX = /[;&|<>$`"'\\*?(){}[\]\n]/;

const PATTERN = /^([A-Za-z0-9_.-]+)\(([^()]+)\)$/;

/** The command as a word to compare: without a folder and a Windows program extension, lower case. */
function commandWord(word: string): string {
  const name = word.split(/[\\/]/).at(-1) ?? word;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function shellCommandAllowable(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const [first, second] = command.trim().split(/\s+/);
  if (first === undefined || first === "") return false;
  const word = commandWord(first);
  if (NEVER_COMMANDS.has(word)) return false;
  return second === undefined || !(NEVER_SUBCOMMANDS[word]?.has(second.toLowerCase()) ?? false);
}

/**
 * Whether "Always allow" may remember `pattern` (a Copilot CLI tool permission pattern) for a repo's tasks: a shell
 * command named in full (`shell(npm test)`) that is none of the refused ones, or one tool of an MCP server
 * (`trackwall(verify_task)`), without a wildcard.
 */
export function alwaysAllowable(pattern: string): boolean {
  const match = PATTERN.exec(pattern);
  const kind = match?.[1];
  const argument = match?.[2];
  if (kind === undefined || argument === undefined || argument.includes("*") || argument.trim() !== argument) return false;
  if (kind === "shell") return shellCommandAllowable(argument);
  return !BUILT_IN_KINDS.has(kind) && /^[A-Za-z0-9_.-]+$/.test(argument);
}
