import { describe, expect, test } from "bun:test";
import { alwaysAllowable } from "../src/always-allow.ts";
import { AlwaysAllowedTool } from "../src/workspace.ts";

describe("what Always allow may remember for a repo's tasks (ADR-249)", () => {
  test("one shell command named in full and one MCP tool may be remembered", () => {
    for (const pattern of [
      "shell(npm test)",
      "shell(mvn -q)",
      "shell(touch)",
      "shell(git status)",
      "shell(git log)",
      "trackwall(verify_task)",
    ]) {
      expect(alwaysAllowable(pattern)).toBe(true);
    }
  });

  test("a whole kind, a wildcard or a built-in kind with an argument is never remembered", () => {
    for (const pattern of ["shell", "write", "url", "shell(mvn:*)", "shell(*)", "write(src/a.ts)", "url(github.com)", "trackwall(*)"]) {
      expect(alwaysAllowable(pattern)).toBe(false);
    }
  });

  test("a command that writes, moves or removes files by path, since an allowed command runs wherever its paths point", () => {
    for (const command of ["rm", "mv", "cp", "tee", "sed", "chmod", "ln", "Remove-Item", "Copy-Item", "Set-Content", "rsync"]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
  });

  test("a shell, an interpreter, a wrapper or a package runner, which run code given on their command line", () => {
    for (const command of [
      "bash",
      "sh",
      "pwsh",
      "cmd.exe",
      "node",
      "python3",
      "bun",
      "env",
      "xargs",
      "find",
      "npx",
      "sudo",
      "/usr/bin/bash",
    ]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
  });

  test("the network, containers and the hosting CLIs", () => {
    for (const command of ["curl", "wget", "ssh", "scp", "Invoke-WebRequest", "docker", "kubectl", "gh", "glab"]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
  });

  test("git push and git config are refused while git status is not, and so are installing and running packages", () => {
    for (const command of [
      "git push",
      "git config",
      "git remote",
      "git -c",
      "npm install",
      "npm i",
      "pnpm add",
      "pnpm dlx",
      "pip install",
      "mise exec",
    ]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
    expect(alwaysAllowable("shell(npm run build)")).toBe(true);
  });

  test("publishing, a program with refused subcommands named bare or with an option first, and Windows' ways to run a file", () => {
    for (const command of [
      "npm publish",
      "npm login",
      "cargo publish",
      "go install",
      "git",
      "npm",
      "git -C ../other push",
      "npm --prefix x install",
    ]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
    for (const command of ["ii", "saps", "cscript", "mshta", "rundll32", "certutil", "cmd.", "rm.exe ", "start.com", "echo %COMSPEC%"]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
  });

  test("shell syntax a label never holds is refused, so a hand edit cannot chain a second command", () => {
    for (const command of ["npm test; rm -rf .", "npm test && curl x", "npm test | sh", "echo $(id)", "npm test > out.txt"]) {
      expect(alwaysAllowable(`shell(${command})`)).toBe(false);
    }
  });

  test("an entry of alwaysAllow in workspace.yaml goes through the same check", () => {
    expect(AlwaysAllowedTool.safeParse({ repo: "shop", tool: "shell(npm test)" }).success).toBe(true);
    expect(AlwaysAllowedTool.safeParse({ repo: "shop", tool: "shell(rm)" }).success).toBe(false);
    expect(AlwaysAllowedTool.safeParse({ repo: "shop", tool: "shell" }).success).toBe(false);
    expect(AlwaysAllowedTool.safeParse({ repo: "shop", tool: "shell(npm test)", repos: ["*"] }).success).toBe(false);
  });
});
