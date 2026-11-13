/**
 * Which tool permission patterns "Always allow" may remember for a repo's tasks (ADR-249). Copilot CLI runs an allowed
 * shell command without asking wherever its paths point, outside the worktree included (its contract test), so only a
 * narrow pattern may be remembered: a named shell command or one MCP tool, never a whole kind (`shell`, `write`), a
 * wildcard, or a command that writes, moves or deletes files by path, reaches the network, runs code given on its
 * command line, raises privileges, or pushes and configures git (git only with a subcommand from a list). The daemon checks the pattern Copilot CLI offers in its
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
  ...["saps", "start-job", "sajb", "ii", "invoke-item", "ipmo", "import-module", "cscript", "wscript", "mshta", "rundll32"],
  ...["regsvr32", "forfiles", "wmic", "assoc", "ftype"],
  // Runtimes that run a source file or a program given as an argument, like the interpreters above.
  ...["java", "javaw", "jbang", "jrunscript", "groovy", "kotlin", "kotlinc", "scala", "rscript", "julia", "tclsh", "swift"],
  // Wrappers that run another command, debuggers and editors that run commands of their own.
  ...["command", "builtin", "setsid", "stdbuf", "flock", "script", "busybox", "chroot", "unshare", "nsenter", "pkexec"],
  ...["runuser", "strace", "ltrace", "gdb", "lldb", "vi", "vim", "nvim", "ex", "emacs"],
  // Shell builtins that change what the session's later commands run: Copilot CLI keeps one shell for the session.
  ...["export", "alias", "set", "unset", "declare", "typeset", "cd", "pushd", "popd"],
  // Opening a file or an address with the program the system picks, which may run it.
  ...["open", "xdg-open", "explorer", "code", "code-insiders", "cursor"],
  // Stopping other processes, the daemon and other sessions among them.
  ...["kill", "pkill", "killall", "taskkill", "stop-process", "spps"],
  // Programs that download and run a package.
  ...["npx", "pnpx", "bunx", "uvx", "pipx"],
  ...["msiexec", "brew", "winget", "choco", "scoop", "gem", "bundle", "poetry", "uv", "conda"],
  // Raising privileges.
  ...["sudo", "su", "doas", "runas", "gsudo"],
  // Writing, moving or removing files by path, the repo's `.git` included.
  ...["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "mv", "move", "move-item", "mi", "cp", "copy", "copy-item"],
  ...["cpi", "xcopy", "robocopy", "tee", "set-content", "sc", "out-file", "add-content", "ac", "ln", "mklink", "new-item", "ni"],
  ...["chmod", "chown", "chgrp", "icacls", "attrib", "takeown", "dd", "truncate", "install", "sed", "awk", "gawk", "patch"],
  ...["tar", "unzip", "7z", "zip", "rsync", "shred"],
  ...["ren", "rni", "rename", "rename-item", "si", "set-item", "tee-object", "expand-archive", "certutil", "bitsadmin"],
  // The network.
  ...["curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet", "socat"],
  ...["invoke-webrequest", "iwr", "invoke-restmethod", "irm"],
  // The system, containers and accounts outside the repo.
  ...["docker", "podman", "kubectl", "helm", "systemctl", "service", "launchctl", "schtasks", "crontab", "at", "reg"],
  ...["regedit", "setx", "gh", "glab", "az", "aws", "gcloud", "terraform"],
]);

/**
 * Subcommands refused for a command allowed otherwise: installing, running and publishing packages. Not Maven's or
 * Gradle's phases, which may come after any option (`mvn -q deploy`), so a prefix pattern cannot leave them out (§8).
 */
const NEVER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["install", "i", "add", "exec", "x", "publish", "login", "adduser", "token", "config", "set"]),
  pnpm: new Set(["add", "install", "i", "dlx", "exec", "publish", "login", "config"]),
  yarn: new Set(["add", "install", "dlx", "exec", "publish", "login", "npm", "config"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  mise: new Set(["exec", "x", "install", "use"]),
  cargo: new Set(["install", "publish", "login"]),
  go: new Set(["install", "get", "run"]),
  dotnet: new Set(["tool", "nuget", "exec", "fsi"]),
};

/**
 * The only subcommands of a program that may be remembered, where refusing some is not enough. A pattern covers every
 * option after it, and most of git's reading commands take ones that reach past the repo: `--output=<path>` writes any
 * file (`log`, `diff`, `show`, `blame`, `shortlog`, `rev-list`, `reflog`, `stash`), `grep -O<program>` and
 * `difftool -x` run a program, `archive -o` and `format-patch -o` write by path, `rebase --exec` and `bisect run` run
 * commands. So for git only these subcommands, checked to take none of those options (a contract test shows
 * `git log --output` writing outside the worktree without a question once `git log` is allowed).
 */
const ONLY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    ...["status", "add", "commit", "rm", "mv", "restore", "switch", "checkout", "branch", "merge", "tag"],
    ...["rev-parse", "ls-files", "ls-tree", "cat-file", "describe", "show-branch", "cherry", "merge-base", "name-rev"],
    ...["check-ignore", "for-each-ref", "count-objects"],
  ]),
};

/** Characters a shell would read as more than one plain command: Copilot CLI's labels never hold them. */
const SHELL_SYNTAX = /[;&|<>$`"'\\*?(){}[\]%\n]/;

const PATTERN = /^([A-Za-z0-9_.-]+)\(([^()]+)\)$/;

/** A tool permission pattern's kind and argument (`shell` and `npm test`); `null` for a bare kind or another shape. */
export function toolPatternParts(pattern: string): { kind: string; argument: string } | null {
  const match = PATTERN.exec(pattern);
  return match?.[1] === undefined || match[2] === undefined ? null : { kind: match[1], argument: match[2] };
}

/**
 * The command as a word to compare: without a folder, a Windows program extension and the trailing dots and spaces
 * Windows ignores, lower case.
 */
function commandWord(word: string): string {
  const name = word.split(/[\\/]/).at(-1) ?? word;
  return name
    .toLowerCase()
    .replace(/[. ]+$/, "")
    .replace(/\.(exe|cmd|bat|com|ps1|vbs|js|msc)$/, "");
}

/** Whether `command` is one plain command, without anything a shell reads as a second one, a redirection or an expansion. */
export function plainShellCommand(command: string): boolean {
  return !SHELL_SYNTAX.test(command);
}

function shellCommandAllowable(command: string): boolean {
  if (!plainShellCommand(command)) return false;
  const [first, second] = command.trim().split(/\s+/);
  if (first === undefined || first === "") return false;
  const word = commandWord(first);
  if (NEVER_COMMANDS.has(word)) return false;
  const refused = NEVER_SUBCOMMANDS[word];
  const only = ONLY_SUBCOMMANDS[word];
  if (refused === undefined && only === undefined) return true;
  // A program with checked subcommands only with one named: neither bare, which would allow them all, nor with an
  // option first (`git -C x push`), which moves the subcommand out of the second word.
  if (second === undefined || second.startsWith("-")) return false;
  const subcommand = second.toLowerCase();
  return only === undefined ? refused?.has(subcommand) !== true : only.has(subcommand);
}

/**
 * Whether "Always allow" may remember `pattern` (a Copilot CLI tool permission pattern) for a repo's tasks: a shell
 * command named in full (`shell(npm test)`) that is none of the refused ones, or one tool of an MCP server
 * (`trackwall(verify_task)`), without a wildcard.
 */
export function alwaysAllowable(pattern: string): boolean {
  const parts = toolPatternParts(pattern);
  if (parts === null || parts.argument.includes("*") || parts.argument.trim() !== parts.argument) return false;
  const { kind, argument } = parts;
  if (kind === "shell") return shellCommandAllowable(argument);
  return !BUILT_IN_KINDS.has(kind) && /^[A-Za-z0-9_.-]+$/.test(argument);
}
