/** The first `x.y.z` in a program's `--version` output (`GitHub Copilot CLI 1.0.103.`, `git version 2.47.1.windows.1`). */
export function versionIn(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Negative when `a` is older than `b`, by `x.y.z` numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
