import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Runs git in a test repo with a fixed author identity, independent of the machine's configuration. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test Author", "-c", "user.email=author@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
}

/**
 * A new repo `parent/name` with the branch `main` (by default in a new temp directory and with SHA-1 objects); the files
 * from `files` written and committed in one commit.
 */
export function makeRepo(
  files: Record<string, string | Buffer> = {},
  name = "repo",
  parent = mkdtempSync(join(tmpdir(), "trackwall-git-")),
  objectFormat: "sha1" | "sha256" = "sha1",
): string {
  const dir = join(parent, name);
  mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main", `--object-format=${objectFormat}`);
  if (Object.keys(files).length > 0) commitFiles(dir, files, "first commit");
  return dir;
}

export function commitFiles(dir: string, files: Record<string, string | Buffer>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", message);
}
