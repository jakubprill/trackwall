/**
 * Uruchamia spike pod Bun ze źródeł i jako skompilowaną binarkę, zbiera wyniki do `results/` i podsumowania CI.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./common.ts";

interface Report {
  platform: string;
  runtime: string;
  compiled: boolean;
  checks: Check[];
}

const root = join(import.meta.dir, "..");
const ext = process.platform === "win32" ? ".exe" : "";
const variants: { label: string; build?: string[]; cmd: string[] }[] = [
  { label: "bun (źródła)", cmd: ["bun", "src/spike.ts"] },
  {
    label: "bun build --compile",
    build: ["bun", "build", "--compile", "src/spike.ts", "--outfile", `dist/job-spike${ext}`],
    cmd: [join(root, "dist", `job-spike${ext}`)],
  },
];

const reports: { label: string; report?: Report; error?: string }[] = [];
for (const v of variants) {
  if (v.build) {
    const b = Bun.spawnSync(v.build, { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) {
      reports.push({ label: v.label, error: `build zakończył się kodem ${b.exitCode}` });
      continue;
    }
  }
  const p = Bun.spawn(v.cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 60_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  await p.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    reports.push({ label: v.label, report: JSON.parse(line) });
  } catch {
    reports.push({ label: v.label, error: `kod ${p.exitCode}; stdout: ${stdout.slice(-500)}; stderr: ${stderr.slice(-1500)}` });
  }
}

const md: string[] = [`### Spike: grupy procesów (${process.platform}-${process.arch})`, ""];
for (const r of reports) {
  md.push(`**${r.label}**${r.report ? ` (${r.report.runtime})` : ""}`, "");
  if (r.error) {
    md.push(`❌ ${r.error.replaceAll("\n", " ")}`, "");
    continue;
  }
  md.push("| Sprawdzenie | Wynik | ms | Szczegóły |", "|---|---|---|---|");
  for (const c of r.report?.checks ?? []) {
    md.push(`| ${c.name} | ${c.ok ? "✅" : c.required ? "❌" : "⚠️"} | ${c.ms ?? ""} | ${c.detail.replaceAll("|", "\\|")} |`);
  }
  md.push("");
}
const text = md.join("\n");
console.log(text);
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", `${process.platform}-${process.arch}.json`), JSON.stringify(reports, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

const ok = reports.every((r) => r.report?.checks.every((c) => c.ok || !c.required));
process.exit(ok ? 0 : 1);
