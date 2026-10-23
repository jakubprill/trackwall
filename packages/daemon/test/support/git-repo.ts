import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Uruchamia gita w repo testowym z ustaloną tożsamością autora, niezależnie od konfiguracji maszyny. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Testowy Autor", "-c", "user.email=autor@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
}

/** Nowe repo w katalogu tymczasowym z gałęzią `main`; pliki z `files` zapisane i zacommitowane jednym commitem. */
export function makeRepo(files: Record<string, string | Buffer> = {}, name = "repo"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pitwall-git-")), name);
  mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  if (Object.keys(files).length > 0) commitFiles(dir, files, "pierwszy commit");
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
