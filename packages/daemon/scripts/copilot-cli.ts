/**
 * The real Copilot CLI for the contract tests (ADR-67): the native binary of the pinned version for this system, from
 * the npm registry, checked against the registry's sha512 and kept in `node_modules/.cache`. A newer Copilot CLI comes
 * in a PR that changes `COPILOT_CLI_VERSION` and passes the contract tests on it. `TRACKWALL_COPILOT_CLI` runs them on
 * another version without that PR, as the nightly workflow does with the newest one on npm.
 *
 *   bun packages/daemon/scripts/copilot-cli.ts     # downloads it when missing and prints the binary's path
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

/** The Copilot CLI version Trackwall is checked against; a download whose `copilot --version` says otherwise is refused. */
export const COPILOT_CLI_VERSION = "1.0.103";

/** An exact version that replaces the pinned one in the contract tests (`.github/workflows/nightly.yml`). */
const VERSION_ENV = "TRACKWALL_COPILOT_CLI";
/** The same pattern as in the `version` job of nightly.yml; keep the two alike. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** The version the contract tests run on: `TRACKWALL_COPILOT_CLI` when set, otherwise the pinned one. */
export function copilotCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  const wanted = env[VERSION_ENV];
  if (wanted === undefined || wanted === "") return COPILOT_CLI_VERSION;
  if (!EXACT_VERSION.test(wanted)) throw new Error(`${VERSION_ENV}="${wanted}" is not an exact version such as 1.0.104`);
  return wanted;
}

const CACHE = fileURLToPath(new URL("../node_modules/.cache/copilot-cli", import.meta.url));
const REGISTRY = "https://registry.npmjs.org";

/** The platform package's name: `@github/copilot` publishes one native binary per system and processor. */
function platformPackage(): string {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw new Error(`Copilot CLI has no build for ${process.platform}`);
  if (!["x64", "arm64"].includes(process.arch)) throw new Error(`Copilot CLI has no build for ${process.arch}`);
  return `@github/copilot-${process.platform}-${process.arch}`;
}

const BINARY = process.platform === "win32" ? "copilot.exe" : "copilot";

/** The binary's path in the cache, downloaded first when it is not there. */
export async function copilotCli(): Promise<string> {
  const version = copilotCliVersion();
  const dir = join(CACHE, version, `${process.platform}-${process.arch}`);
  const binary = join(dir, BINARY);
  if (existsSync(binary)) return binary;
  const name = platformPackage();
  const tarball = await download(name, version);
  const file = tarFile(gunzipSync(tarball), `package/${BINARY}`);
  mkdirSync(dir, { recursive: true });
  // Written next to the target and renamed, so that a broken download never leaves a binary that looks complete.
  const partial = `${binary}.partial`;
  writeFileSync(partial, file);
  chmodSync(partial, 0o755);
  const check = spawnSync(partial, ["--version"], { encoding: "utf8" });
  if (check.error) throw new Error(`${name}: the downloaded binary does not start (${check.error.message})`);
  if (!check.stdout.includes(` ${version}.`)) {
    throw new Error(`${name} says it is "${check.stdout.trim()}" (exit ${check.status}, ${check.stderr.trim()}), not ${version}`);
  }
  rmSync(binary, { force: true });
  renameSync(partial, binary);
  return binary;
}

const PackageVersion = z.object({ dist: z.object({ tarball: z.url(), integrity: z.string().startsWith("sha512-") }) });

async function download(name: string, version: string): Promise<Buffer> {
  const metadata = await fetch(`${REGISTRY}/${name}/${version}`);
  if (!metadata.ok) throw new Error(`${name}@${version}: the registry answered ${metadata.status}`);
  const { dist } = PackageVersion.parse(await metadata.json());
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`${dist.tarball}: ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const digest = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (digest !== dist.integrity) throw new Error(`${dist.tarball}: the sha512 is not the registry's (${digest})`);
  return tarball;
}

const BLOCK = 512;

/**
 * One file from a ustar archive (an npm tarball). Read here rather than with the system's `tar`: on Windows runners
 * the `tar` of Git for Windows comes first in `PATH` and takes `C:` in a path for a remote host.
 */
function tarFile(archive: Buffer, path: string): Buffer {
  for (let offset = 0; offset + BLOCK <= archive.length; ) {
    const header = archive.subarray(offset, offset + BLOCK);
    const name = cString(header.subarray(0, 100));
    if (name === "") break;
    const prefix = cString(header.subarray(345, 500));
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim(), 8);
    const start = offset + BLOCK;
    if ((prefix === "" ? name : `${prefix}/${name}`) === path) return archive.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error(`no ${path} in the Copilot CLI package`);
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

if (import.meta.main) {
  const binary = await copilotCli();
  process.stdout.write(`${binary}\n`);
}
