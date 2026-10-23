/**
 * Macierz: backend PTY × sposób uruchomienia (Node jako punkt odniesienia, Bun ze źródeł, skompilowana binarka).
 * Każdy przypadek w osobnym procesie z limitem czasu; wyniki do `results/` i podsumowania CI.
 */
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ext = process.platform === "win32" ? ".exe" : "";
const compiled = join(root, "dist", `pty-spike${ext}`);

const build = Bun.spawnSync(["bun", "build", "--compile", "src/spike.ts", "--outfile", compiled], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const compiledOk = build.exitCode === 0;

const cases: { label: string; cmd: string[]; cwd?: string }[] = [
  { label: "node-pty / node", cmd: ["node", "--experimental-strip-types", "--no-warnings", "src/spike.ts", "node-pty"] },
  { label: "node-pty / bun", cmd: ["bun", "src/spike.ts", "node-pty"] },
  { label: "bun-pty / bun", cmd: ["bun", "src/spike.ts", "bun-pty"] },
  { label: "Bun.spawn terminal / bun", cmd: ["bun", "src/spike.ts", "bun-terminal"] },
];
if (compiledOk) {
  cases.push(
    { label: "node-pty / bun --compile", cmd: [compiled, "node-pty"] },
    { label: "bun-pty / bun --compile", cmd: [compiled, "bun-pty"] },
    { label: "Bun.spawn terminal / bun --compile", cmd: [compiled, "bun-terminal"] },
  );
  // Portable: binarka skopiowana poza repo, bez node_modules obok. Tak będzie wyglądać rozpakowany zip.
  const movedDir = mkdtempSync(join(tmpdir(), "pty-spike-moved-"));
  const moved = join(movedDir, `pty-spike${ext}`);
  copyFileSync(compiled, moved);
  for (const b of ["node-pty", "bun-pty", "bun-terminal"]) {
    cases.push({ label: `${b} / --compile, binarka przeniesiona poza repo`, cmd: [moved, b], cwd: movedDir });
  }
}

interface Row {
  label: string;
  ok: boolean;
  summary: string;
  raw?: unknown;
}
const rows: Row[] = [];
if (!compiledOk) rows.push({ label: "bun build --compile", ok: false, summary: `build zakończył się kodem ${build.exitCode}` });

for (const c of cases) {
  const p = Bun.spawn(c.cmd, { cwd: c.cwd ?? root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 45_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  const code = await p.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const r = JSON.parse(line) as { ok: boolean; steps: { step: string; ok: boolean; detail?: string; ms?: number }[] };
    const failed = r.steps.filter((s) => !s.ok);
    const summary = r.ok
      ? r.steps.map((s) => `${s.step} ${s.ms} ms`).join(", ")
      : failed.map((s) => `${s.step}: ${(s.detail ?? "").split("\n")[0]}`).join("; ");
    rows.push({ label: c.label, ok: r.ok, summary, raw: r });
  } catch {
    rows.push({
      label: c.label,
      ok: false,
      summary: `proces zakończył się kodem ${code} bez wyniku; stderr: ${stderr.trim().split("\n").slice(-3).join(" ⏎ ")}`,
    });
  }
}

const md = [
  `### Spike: PTY (${process.platform}-${process.arch})`,
  "",
  "| Backend / uruchomienie | Wynik | Szczegóły |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.label} | ${r.ok ? "✅" : "❌"} | ${r.summary.replaceAll("|", "\\|").slice(0, 400)} |`),
  "",
].join("\n");
console.log(md);
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", `${process.platform}-${process.arch}.json`), JSON.stringify(rows, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
// Spike ma odpowiedzieć „który backend działa”, więc sukces = co najmniej jedna działająca ścieżka pod skompilowanym Bun.
process.exit(rows.some((r) => r.ok && r.label.includes("--compile")) ? 0 : 1);
